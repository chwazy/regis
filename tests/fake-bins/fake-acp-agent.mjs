import process from 'node:process';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? 'simple';
const SESSION_ID = 'sess_fake_1';
const PERMISSION_REQUEST_ID = 100;
let promptId;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(payload) {
  send({ method: 'session/update', params: { sessionId: SESSION_ID, update: payload } });
}

function chunk(text) {
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } });
}

function finish(stopReason) {
  send({ id: promptId, result: { stopReason } });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const protocolVersion = mode === 'badversion' ? 7 : message.params.protocolVersion;
    send({ id: message.id, result: { protocolVersion, agentCapabilities: {}, authMethods: [] } });
  } else if (message.method === 'session/new') {
    send({ id: message.id, result: { sessionId: SESSION_ID } });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
    if (mode === 'hang') {
      return;
    }
    if (mode === 'env') {
      chunk(process.env.REGIS_ACP_TEST_LEAK === undefined ? 'leak:absent' : 'leak:present');
      finish('end_turn');
      return;
    }
    chunk('Hel');
    chunk('lo');
    if (mode === 'permission') {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Write file',
        kind: 'edit',
        status: 'pending',
      });
      send({
        id: PERMISSION_REQUEST_ID,
        method: 'session/request_permission',
        params: {
          sessionId: SESSION_ID,
          toolCall: { toolCallId: 'call_1', title: 'Write file', rawInput: { path: 'a.txt' } },
          options: [
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      return;
    }
    if (mode === 'tool') {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'contents' } }],
      });
      chunk('Done');
    }
    finish('end_turn');
  } else if (message.method === 'session/cancel') {
    finish('cancelled');
  } else if (message.id === PERMISSION_REQUEST_ID && message.result) {
    const outcome = message.result.outcome;
    chunk(outcome.outcome === 'selected' ? `permission:${outcome.optionId}` : 'permission:cancelled');
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' });
    finish('end_turn');
  }
});
