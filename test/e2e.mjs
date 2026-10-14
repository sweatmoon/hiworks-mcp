// 목(mock) POP3/SMTP 서버를 띄우고 MCP 클라이언트로 모든 도구를 호출해 보는 통합 테스트.
// 실제 하이웍스 계정 없이 `npm test` 로 실행한다.
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startPop3, startSmtp, messages } from './mock-servers.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const stateDir = path.join(os.tmpdir(), 'hiworks-mcp-test', 'state'); const dlDir = path.join(os.tmpdir(), 'hiworks-mcp-test', 'downloads');
fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(dlDir, { recursive: true, force: true });

const pop = await startPop3(11110); const smtp = await startSmtp(12525);
const transport = new StdioClientTransport({
  command: 'node', args: [path.join(here, '..', 'build', 'index.js')],
  env: { ...process.env, HIWORKS_USERNAME: 'me@hiworks.com', HIWORKS_PASSWORD: 'secret',
    HIWORKS_POP3_HOST: '127.0.0.1', HIWORKS_POP3_PORT: '11110', HIWORKS_POP3_TLS: 'false',
    HIWORKS_SMTP_HOST: '127.0.0.1', HIWORKS_SMTP_PORT: '12525', HIWORKS_SMTP_SECURE: 'false',
    HIWORKS_STATE_DIR: stateDir, HIWORKS_DOWNLOAD_DIR: dlDir },
});
const client = new Client({ name: 'test', version: '0.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return JSON.parse(r.content[0].text); };
const decoded = (d) => d + '\n' + d.split(/\n\n/).slice(1).map((b) => { try { return Buffer.from(b.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return ''; } }).join('\n');
let pass = 0; const ok = (label, cond) => { assert.ok(cond, label); pass++; console.log('  ✓', label); };

console.log('tools');
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('   ', tools.join(', '));
ok('9 tools registered', tools.length === 9);

console.log('read_username');
const acct = await call('read_username');
ok('returns username, no password', acct.username === 'me@hiworks.com' && !('password' in acct));

console.log('search_email');
let s = await call('search_email');
ok('default returns all 4 newest-first', s.emails.length === 4 && s.emails[0].subject.includes('계약서') && s.total === 4);
ok('header has uid/msgNum/date KST', s.emails[0].uid.startsWith('UID-') && s.emails[0].msgNum === 4 && s.emails[0].date === '2025-09-04T11:15:00+09:00');
ok('hasAttachments flagged on multipart', s.emails.find((e) => e.subject === '견적서 송부').hasAttachments === true);
s = await call('search_email', { from: 'vendor' });
ok('from filter', s.emails.length === 1 && s.emails[0].subject === '견적서 송부');
s = await call('search_email', { query: '긴급' });
ok('query filter on subject', s.emails.length === 1 && s.emails[0].msgNum === 4);
s = await call('search_email', { since: '2025-09-03' });
ok('since filter (date-only KST)', s.emails.length === 2 && s.emails.every((e) => e.msgNum >= 3));
s = await call('search_email', { since: '2025-09-02', before: '2025-09-03' });
ok('since+before range', s.emails.length === 2 && s.emails.map((e) => e.msgNum).join() === '3,2');
s = await call('search_email', { hasAttachments: true });
ok('hasAttachments filter', s.emails.length === 1 && s.emails[0].msgNum === 1);
s = await call('search_email', { limit: 2, offset: 1 });
ok('limit+offset pagination', s.emails.map((e) => e.msgNum).join() === '3,2');
s = await call('search_email', { to: 'boss' });
ok('to filter matches cc', s.emails.length === 1 && s.emails[0].msgNum === 2);

console.log('read_email');
const uid = s.emails[0].uid;
let r = await call('read_email', { messageId: uid });
ok('by uid', r.success && r.email.subject === '회의 일정 조율' && r.email.content.includes('화요일') && r.email.replyTo === 'lee.secretary@partner.co.kr');
r = await call('read_email', { messageId: '3' });
ok('by msgNum, html omitted by default', r.success && r.email.msgNum === 3 && !('html' in r.email));
r = await call('read_email', { messageId: '3', includeHtml: true });
ok('includeHtml', r.email.html.includes('<b>world</b>'));
r = await call('read_email', { messageId: '<m1@test>' });
ok('by Message-ID with brackets', r.success && r.email.msgNum === 1 && r.email.attachments.length === 1 && r.email.attachments[0].filename === '견적서.txt');
r = await call('read_email', { messageId: 'm1@test', maxLength: 5 });
ok('maxLength truncation', r.truncated === true && r.email.content.startsWith('견적서 보'));
r = await call('read_email', { messageId: 'nope@nope' });
ok('not found', r.success === false && r.error.includes('찾을 수 없'));

console.log('check_new_emails');
let n = await call('check_new_emails', { limit: 2 });
ok('first run: firstRun=true, returns latest 2, tracked 4', n.firstRun && n.emails.length === 2 && n.trackedCount === 4 && n.newCount === 0);
n = await call('check_new_emails');
ok('second run: nothing new', !n.firstRun && n.newCount === 0 && n.emails.length === 0);
pop.state.messages.push(messages[0].replace('m1@test', 'm5@test').replace('견적서 송부', '새로 온 메일'));
n = await call('check_new_emails', { markAsSeen: false });
ok('new mail detected, markAsSeen=false', n.newCount === 1 && n.emails[0].subject === '새로 온 메일');
n = await call('check_new_emails');
ok('still new (was not marked)', n.newCount === 1);
n = await call('check_new_emails');
ok('now marked seen', n.newCount === 0);
n = await call('check_new_emails', { reset: true, limit: 0 });
ok('reset → firstRun again with limit 0', n.firstRun && n.emails.length === 0 && n.trackedCount === 5);

console.log('attachments');
let a = await call('list_attachments', { messageId: 'm1@test' });
ok('list_attachments', a.success && a.attachments[0].filename === '견적서.txt' && a.attachments[0].size === 17);
a = await call('save_attachment', { messageId: 'm1@test' });
ok('save_attachment default dir', a.success && fs.readFileSync(a.saved[0].path, 'utf8') === 'quote content 123' && a.saved[0].path.startsWith(dlDir));
a = await call('save_attachment', { messageId: 'm1@test', index: 0 });
ok('no overwrite → numbered copy', a.saved[0].path.endsWith('견적서 (1).txt'));
a = await call('save_attachment', { messageId: 'm1@test', filename: 'missing.pdf' });
ok('missing filename → error with list', a.success === false && a.attachments.length === 1);
a = await call('save_attachment', { messageId: '2' });
ok('mail without attachments → error', a.success === false);

console.log('send_email');
let se = await call('send_email', { to: 'a@x.com, b@y.com', cc: ['c@z.com'], subject: '테스트', text: '본문입니다', attachments: [{ filename: 'hi.txt', content: 'aGVsbG8=', encoding: 'base64' }] });
let last = smtp.state.sent.at(-1);
ok('sent, 3 recipients, attachment present', se.success && se.accepted.length === 3 && last.to.length === 3 && /filename="?hi.txt"?/.test(last.data) && last.data.includes('aGVsbG8='));
se = await call('send_email', { to: 'a@x.com', subject: 'x' });
ok('no body → error', se.success === false);
se = await call('send_email', { to: 'a@x.com', subject: 'x', text: 'y', attachments: [{ path: '/nonexistent/file.pdf' }] });
ok('missing attachment path → error', se.success === false && se.error.includes('찾을 수 없'));

console.log('reply_email');
let rp = await call('reply_email', { messageId: '2', text: '네, 화요일 좋습니다.', replyAll: true });
last = smtp.state.sent.at(-1);
ok('reply goes to Reply-To, replyAll cc excludes self', rp.to.join() === 'lee.secretary@partner.co.kr' && rp.cc.join() === 'boss@hiworks.com');
ok('Re: subject + In-Reply-To + quote', rp.subject === 'Re: 회의 일정 조율' && last.data.includes('In-Reply-To: <m2@test>') && last.data.includes('References: <m2@test>') && decoded(last.data).includes('> 다음주 화요일') && decoded(last.data).includes('작성:'));
rp = await call('reply_email', { messageId: '3', text: 'thanks', quoteOriginal: false });
last = smtp.state.sent.at(-1);
ok('reply html-only mail without quote', rp.success && rp.to.join() === 'noreply@newsletter.com' && !decoded(last.data).includes('작성:'));
rp = await call('reply_email', { messageId: '2', text: 'x' });
ok('reply (not all) has no cc', rp.cc.length === 0);

console.log('forward_email');
let fw = await call('forward_email', { messageId: 'm1@test', to: 'colleague@hiworks.com', text: '참고하세요' });
last = smtp.state.sent.at(-1);

ok('Fwd: subject, attachment forwarded, header block', fw.subject === 'Fwd: 견적서 송부' && fw.forwardedAttachments === 1 && /filename\*?0?\*?=/.test(last.data) && decoded(last.data).includes('전달된 메일'));
fw = await call('forward_email', { messageId: 'm1@test', to: 'c@d.com', includeAttachments: false });
ok('includeAttachments=false', fw.forwardedAttachments === 0);

console.log('auth failure');
const bad = await call('search_email', { password: 'wrong' });
ok('wrong password → clean error', bad.success === false && /Authentication/.test(bad.error));

await client.close(); pop.server.close(); smtp.server.close();
console.log(`\nALL ${pass} CHECKS PASSED`);
