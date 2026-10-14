import net from 'net';

const CRLF = '\r\n';

function mail({ id, from, to, cc, subject, date, text, html, replyTo, attachment }) {
  const lines = [
    `Message-ID: <${id}>`,
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
  ];
  if (attachment) {
    const b = 'BOUNDARY123';
    lines.push(`Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`,
      'Content-Type: text/plain; charset=utf-8', '', text, '',
      `--${b}`, `Content-Type: ${attachment.type}; name="${attachment.name}"`,
      'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${attachment.name}"`, '',
      Buffer.from(attachment.content).toString('base64'), `--${b}--`);
  } else if (html) {
    lines.push('Content-Type: text/html; charset=utf-8', '', html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', text);
  }
  return lines.join(CRLF);
}

export const messages = [
  mail({ id: 'm1@test', from: 'Kim <kim@vendor.com>', to: 'me@hiworks.com', subject: '견적서 송부', date: 'Mon, 01 Sep 2025 09:00:00 +0900', text: '견적서 보내드립니다.', attachment: { name: '견적서.txt', type: 'text/plain', content: 'quote content 123' } }),
  mail({ id: 'm2@test', from: 'Lee <lee@partner.co.kr>', to: 'me@hiworks.com', cc: 'boss@hiworks.com', subject: '회의 일정 조율', date: 'Tue, 02 Sep 2025 14:30:00 +0900', text: '다음주 화요일 괜찮으신가요?', replyTo: 'lee.secretary@partner.co.kr' }),
  mail({ id: 'm3@test', from: 'noreply@newsletter.com', to: 'me@hiworks.com', subject: 'Weekly Newsletter', date: 'Wed, 03 Sep 2025 08:00:00 +0900', html: '<html><body><p>Hello <b>world</b></p><p>Second para</p></body></html>' }),
  mail({ id: 'm4@test', from: 'Park <park@client.com>', to: 'me@hiworks.com', subject: '[긴급] 계약서 검토 요청', date: 'Thu, 04 Sep 2025 11:15:00 +0900', text: '첨부 계약서 검토 부탁드립니다.' }),
];

export function startPop3(port) {
  const state = { messages: [...messages], log: [] };
  const server = net.createServer((sock) => {
    sock.write(`+OK mock POP3 ready${CRLF}`);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const [cmd, ...args] = line.split(' ');
        state.log.push(line);
        const msgs = state.messages;
        const uid = (i) => `UID-${Buffer.from(msgs[i].match(/Message-ID: <(.*)>/)[1]).toString('hex')}`;
        switch (cmd.toUpperCase()) {
          case 'USER': sock.write(`+OK${CRLF}`); break;
          case 'PASS': sock.write(args[0] === 'secret' ? `+OK Logged in.${CRLF}` : `-ERR [AUTH] Authentication failed.${CRLF}`); break;
          case 'STAT': sock.write(`+OK ${msgs.length} ${msgs.reduce((a, m) => a + m.length, 0)}${CRLF}`); break;
          case 'NOOP': sock.write(`+OK${CRLF}`); break;
          case 'LIST': sock.write(`+OK ${msgs.length} messages${CRLF}` + msgs.map((m, i) => `${i + 1} ${m.length}`).join(CRLF) + `${CRLF}.${CRLF}`); break;
          case 'UIDL': sock.write(`+OK${CRLF}` + msgs.map((m, i) => `${i + 1} ${uid(i)}`).join(CRLF) + `${CRLF}.${CRLF}`); break;
          case 'TOP': { const n = Number(args[0]); const m = msgs[n - 1]; if (!m) { sock.write(`-ERR no such message${CRLF}`); break; } const hdr = m.split(CRLF + CRLF)[0]; sock.write(`+OK${CRLF}${hdr}${CRLF}${CRLF}.${CRLF}`); break; }
          case 'RETR': { const n = Number(args[0]); const m = msgs[n - 1]; if (!m) { sock.write(`-ERR no such message${CRLF}`); break; } sock.write(`+OK ${m.length} octets${CRLF}${m}${CRLF}.${CRLF}`); break; }
          case 'QUIT': sock.write(`+OK Bye${CRLF}`); sock.end(); break;
          default: sock.write(`-ERR unknown${CRLF}`);
        }
      }
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  state.stop = () => new Promise((res) => { for (const s of sockets) s.destroy(); server.close(() => res()); });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, state })));
}

export function startSmtp(port) {
  const state = { sent: [] };
  const server = net.createServer((sock) => {
    sock.write(`220 mock SMTP${CRLF}`);
    let buf = ''; let inData = false; let cur = { from: '', to: [], data: '' };
    sock.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; state.sent.push(cur); cur = { from: '', to: [], data: '' }; sock.write(`250 OK queued${CRLF}`); }
          else cur.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write(`250-mock${CRLF}250-AUTH PLAIN LOGIN${CRLF}250 8BITMIME${CRLF}`);
        else if (up.startsWith('HELO')) sock.write(`250 mock${CRLF}`);
        else if (up.startsWith('AUTH PLAIN')) sock.write(`235 ok${CRLF}`);
        else if (up.startsWith('AUTH LOGIN')) sock.write(`334 VXNlcm5hbWU6${CRLF}`);
        else if (up.startsWith('MAIL FROM')) { cur.from = line; sock.write(`250 ok${CRLF}`); }
        else if (up.startsWith('RCPT TO')) { cur.to.push(line.replace(/^RCPT TO:/i, '').trim()); sock.write(`250 ok${CRLF}`); }
        else if (up === 'DATA') { inData = true; sock.write(`354 go${CRLF}`); }
        else if (up === 'QUIT') { sock.write(`221 bye${CRLF}`); sock.end(); }
        else if (up === 'RSET') sock.write(`250 ok${CRLF}`);
        else sock.write(`250 ok${CRLF}`);
      }
    });
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, state })));
}
