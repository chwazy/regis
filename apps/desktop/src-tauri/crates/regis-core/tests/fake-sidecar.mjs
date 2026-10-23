import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const waitingForHost = new Map();
let nextHostId = 1000;

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'system.ping') {
    const hostId = nextHostId++;
    waitingForHost.set(hostId, (hostReply) =>
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { name: 'regis-sidecar', version: 'test', pid: process.pid, hostReply },
      }),
    );
    send({ jsonrpc: '2.0', id: hostId, method: 'host.ping' });
  } else if (message.method === 'system.exit') {
    process.exit(0);
  } else if (message.method === undefined && waitingForHost.has(message.id)) {
    waitingForHost.get(message.id)(message.result);
    waitingForHost.delete(message.id);
  }
});
