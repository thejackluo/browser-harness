import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest, parseReply, type CompletionRequest } from '../src/protocol.js';

const tool = { type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
const base: CompletionRequest = { model: 'chatgpt-browser', messages: [{ role: 'user', content: 'Read the README' }], tools: [tool] };

test('validates complete tool arrays and assigns unique IDs', () => {
  const prepared = prepareRequest(base);
  const result = parseReply(JSON.stringify({ nonce: prepared.nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: { path: 'README.md' } }, { name: 'read_file', arguments: { path: 'package.json' } }] }), prepared);
  assert.equal(result.tool_calls?.length, 2);
  assert.notEqual(result.tool_calls?.[0]?.id, result.tool_calls?.[1]?.id);
});

for (const [label, change] of Object.entries({
  'wrong nonce': { nonce: 'other' },
  'undeclared tool': { tool_calls: [{ name: 'run_shell', arguments: {} }] },
  'wrong argument type': { tool_calls: [{ name: 'read_file', arguments: { path: 1 } }] },
  'extra argument': { tool_calls: [{ name: 'read_file', arguments: { path: 'x', command: 'x' } }] },
  'empty tool list': { tool_calls: [] },
  'extra envelope field': { explanation: 'example' },
})) {
  test(`rejects ${label}`, () => {
    const prepared = prepareRequest(base);
    assert.throws(() => parseReply(JSON.stringify({ nonce: prepared.nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: { path: 'x' } }], ...change }), prepared), /protocol validation/);
  });
}

test('does not interpret prose or fenced examples as actions', () => {
  const prepared = prepareRequest(base);
  const call = JSON.stringify({ nonce: prepared.nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: { path: 'x' } }] });
  assert.throws(() => parseReply(`Example: ${call}`, prepared));
  assert.throws(() => parseReply('```json\n' + call + '\n```', prepared));
});

test('retains full tool history, IDs and arguments in browser prompt', () => {
  const request: CompletionRequest = { ...base, messages: [...base.messages,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: 'file contents' },
  ] };
  const prepared = prepareRequest(request);
  assert.ok(prepared.prompt.includes(JSON.stringify(request.messages)));
  const reply = parseReply(JSON.stringify({ nonce: prepared.nonce, type: 'final', content: 'Done' }), prepared);
  assert.equal(reply.content, 'Done');
});

test('rejects unpaired, pending, duplicate and role-confused tool histories', () => {
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: 'tool', content: 'x', tool_call_id: 'missing' }] }));
  const call = { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  assert.throws(() => prepareRequest({ ...base, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [call] }] }));
  assert.throws(() => prepareRequest({ ...base, messages: [...base.messages, { role: 'user', content: 'x', tool_calls: [call] }] }));
  assert.throws(() => prepareRequest({ ...base, messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [call, call] }] }));
});

test('rejects unsupported models, modalities, parameters and schemas', () => {
  assert.throws(() => prepareRequest({ ...base, model: 'sol' }));
  assert.throws(() => prepareRequest({ ...base, temperature: 0.2 }));
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com' } }] }] }));
  assert.throws(() => prepareRequest({ ...base, tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'object', $ref: 'https://example.com/schema' } } }] }));
  assert.throws(() => prepareRequest({ ...base, tools: [tool, tool] }));
  assert.throws(() => prepareRequest({ ...base, tools: [{ ...tool, function: { ...tool.function, parameters: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } } }] }));
});

test('respects required/none/serial tool choice', () => {
  const required = prepareRequest({ ...base, tool_choice: 'required' });
  assert.throws(() => parseReply(JSON.stringify({ nonce: required.nonce, type: 'final', content: 'done' }), required));
  assert.throws(() => prepareRequest({ ...base, tools: [], tool_choice: 'required' }));
  for (const options of [{ tool_choice: 'none' }, { parallel_tool_calls: false }]) {
    const prepared = prepareRequest({ ...base, ...options });
    assert.throws(() => parseReply(JSON.stringify({ nonce: prepared.nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: { path: 'x' } }, { name: 'read_file', arguments: { path: 'y' } }] }), prepared));
  }
});

test('permits literal reference-like keys in const, enum and property names', () => {
  const parameters = {
    type: 'object',
    properties: { literal: { const: { $ref: 'data' } }, choice: { enum: [{ $id: 'data' }] }, $ref: { type: 'string' } },
    required: ['literal', 'choice', '$ref'], additionalProperties: false,
  };
  const prepared = prepareRequest({ ...base, tools: [{ ...tool, function: { ...tool.function, parameters } }] });
  const args = { literal: { $ref: 'data' }, choice: { $id: 'data' }, $ref: 'data' };
  const result = parseReply(JSON.stringify({ nonce: prepared.nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: args }] }), prepared);
  assert.deepEqual(JSON.parse(result.tool_calls![0]!.function.arguments), args);
});

test('still rejects real references inside nested schema positions', () => {
  for (const parameters of [
    { type: 'object', properties: { nested: { $ref: '#' } } },
    { type: 'object', properties: { list: { type: 'array', items: { $ref: '#' } } } },
    { type: 'object', allOf: [{ $ref: '#' }] },
    { type: 'object', additionalProperties: { $ref: '#' } },
    { type: 'object', dependencies: { field: { $ref: '#' } } },
    { type: 'object', $defs: { unused: { $ref: 'https://example.com/schema' } } },
    { type: 'object', $defs: { unused: { $id: 'https://example.com/schema' } } },
    { type: 'object', $defs: { unused: { $async: true } } },
  ]) {
    assert.throws(() => prepareRequest({ ...base, tools: [{ ...tool, function: { ...tool.function, parameters } }] }), /may not use/);
  }
});

test('accepts token ceilings, stream options and text content parts', () => {
  const prepared = prepareRequest({
    ...base, max_tokens: 32000, reasoning_effort: 'medium', stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: [{ type: 'text', text: 'Be brief.' }] }, { role: 'user', content: [{ type: 'text', text: 'Read' }, { type: 'text', text: 'the README' }] }],
  });
  assert.equal(prepared.request.messages[1]?.content, 'Read\n\nthe README');
});

test('rejects non-text content parts', () => {
  assert.throws(() => prepareRequest({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }), /Unsupported request/);
});

test('compiles draft 2020-12 and draft-07 tool schemas and rejects unknown drafts', () => {
  const schema = (draft: string) => ({ ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, $schema: draft } } });
  for (const draft of ['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#']) {
    const prepared = prepareRequest({ ...base, tools: [schema(draft)] });
    assert.throws(() => parseReply(JSON.stringify({ nonce: prepared.nonce, type: 'tool_calls', tool_calls: [{ name: 'read_file', arguments: { path: 1 } }] }), prepared));
  }
  assert.throws(() => prepareRequest({ ...base, tools: [schema('https://example.com/schema')] }), /draft/);
});

test('rejects references nested in draft 2020-12 subschema keywords', () => {
  const draft = 'https://json-schema.org/draft/2020-12/schema';
  for (const extra of [
    { properties: { list: { type: 'array', prefixItems: [{ $ref: '#' }] } } },
    { dependentSchemas: { path: { $ref: '#' } } },
    { unevaluatedProperties: { $ref: '#' } },
    { properties: { list: { type: 'array', unevaluatedItems: { $dynamicRef: '#x' } } } },
  ]) {
    const parameters = { $schema: draft, type: 'object', ...extra };
    assert.throws(() => prepareRequest({ ...base, tools: [{ ...tool, function: { ...tool.function, parameters } }] }), /\$ref/);
  }
});
