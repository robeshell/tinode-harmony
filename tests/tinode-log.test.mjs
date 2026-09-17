import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resetTinodeLogSink, setTinodeLogSink, tinodeLogDetail, tinodeLogFailure
} from '../src/Index.ts';

// SDK 的日志端口：宿主注入后 SDK 才出声；不注入时静默（SDK 不依赖宿主日志模块）

test('日志端口：注入前静默，注入后转发，reset 后恢复静默', () => {
  const seen = [];
  // 注入前：不应抛错，也不应有任何输出（这里只能断言不抛）
  assert.doesNotThrow(() => tinodeLogDetail('sdk/test', 'before inject', 'info'));
  setTinodeLogSink({
    detail: (tag, message, level) => { seen.push(`D:${tag}:${message}:${level}`); },
    failure: (tag, error) => { seen.push(`F:${tag}:${String(error)}`); }
  });
  tinodeLogDetail('sdk/test', 'hello', 'warn');
  tinodeLogFailure('sdk/test', new Error('boom'));
  assert.deepEqual(seen, ['D:sdk/test:hello:warn', 'F:sdk/test:Error: boom']);
  resetTinodeLogSink();
  tinodeLogDetail('sdk/test', 'after reset', 'info');
  assert.equal(seen.length, 2, 'reset 之后不再转发（静默）');
});
