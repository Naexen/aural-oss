import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { openAsr, testAsr, type AsrEvent, type AsrProfile } from "../src/main/asr";

const profile: AsrProfile = { protocol: "qwen", apiKey: "mock-asr-key", baseUrl: "", model: "" };

async function localProvider(t: TestContext) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  return {
    server,
    createSocket(_target: string, options: WebSocket.ClientOptions) {
      return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    },
  };
}

function send(socket: WebSocket, payload: object) {
  socket.send(JSON.stringify(payload));
}

test("Qwen realtime sends PCM, emits one final per item, and drains a late final before close", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  const outbound: string[] = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer mock-asr-key");
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString());
      outbound.push(command.type);
      if (command.type === "session.update") {
        assert.equal(command.session.sample_rate, 16_000);
        send(socket, { type: "session.updated" });
      } else if (command.type === "input_audio_buffer.append") {
        assert.deepEqual(Buffer.from(command.audio, "base64"), Buffer.from([1, 2, 3, 4]));
      } else if (command.type === "session.finish") {
        const partial = (id: string, text: string, stash = "") => send(socket, { type: "conversation.item.input_audio_transcription.text", item_id: id, text, stash });
        const final = (id: string, transcript: string) => send(socket, { type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
        partial("item-1", "我先", "确认");
        partial("item-1", "我先", "确认");
        partial("item-2", "我再");
        final("item-1", "我先确认。");
        final("item-1", "我先确认。");
        partial("item-1", "过期草稿");
        final("item-2", "我先确认。");
        send(socket, { type: "session.finished" });
      }
    });
  });

  const events: AsrEvent[] = [];
  const connection = await openAsr({ ...profile, baseUrl: "wss://provider.example/realtime?model=old", model: "mock-realtime" }, (event) => events.push(event), (target, options) => {
    assert.equal(target, "wss://provider.example/realtime?model=mock-realtime");
    return createSocket(target, options);
  });
  connection.write(new Uint8Array([9, 1, 2, 3, 4, 9]).subarray(1, 5));
  connection.close();
  connection.close();
  connection.write(new Uint8Array([5, 6]));
  await connection.closed;
  assert.deepEqual(outbound, ["session.update", "input_audio_buffer.append", "session.finish"]);
  assert.deepEqual(events, [
    { type: "partial", id: "item-1", text: "我先确认" },
    { type: "partial", id: "item-2", text: "我再" },
    { type: "final", id: "item-1", text: "我先确认。" },
    { type: "final", id: "item-2", text: "我先确认。" },
  ]);
});

test("Qwen Audio uses the configured model, binary PCM, and only current-task results", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  let id: string;
  server.on("connection", (socket) => socket.on("message", (raw, binary) => {
    if (binary) {
      assert.deepEqual(Buffer.from(raw as Buffer), Buffer.from([0, 127]));
      return;
    }
    const command = JSON.parse(raw.toString());
    if (command.header.action === "run-task") {
      id = command.header.task_id;
      assert.equal(command.payload.model, "mock-streaming");
      send(socket, { header: { event: "task-started", task_id: id } });
    } else {
      assert.equal(command.header.action, "finish-task");
      assert.equal(command.header.task_id, id);
      send(socket, { header: { event: "task-finished", task_id: "previous-task" } });
      const sentence = (task: string, sentence_end: boolean, text: string) => send(socket, {
        header: { event: "result-generated", task_id: task },
        payload: { output: { sentence: { begin_time: 12, sentence_end, text } } },
      });
      sentence("previous-task", true, "错任务");
      sentence(id, false, "有" );
      sentence(id, true, "有结果。" );
      sentence(id, true, "重复结果。" );
      send(socket, { header: { event: "task-finished", task_id: id } });
    }
  }));
  const events: AsrEvent[] = [];
  const connection = await openAsr({ ...profile, protocol: "qwen-audio", model: "mock-streaming" }, (event) => events.push(event), (target, options) => {
    assert.equal(target, "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
    return createSocket(target, options);
  });
  connection.write(new Uint8Array([0, 127]));
  connection.close();
  await connection.closed;
  assert.deepEqual(events, [
    { type: "partial", id: "12", text: "有" },
    { type: "final", id: "12", text: "有结果。" },
  ]);
});

test("connection tests wait for provider acknowledgement and never send audio", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  const sent: string[] = [];
  server.on("connection", (socket) => socket.on("message", (raw) => {
    sent.push(JSON.parse(raw.toString()).type);
    send(socket, { type: "session.updated" });
  }));
  await testAsr(profile, createSocket);
  assert.deepEqual(sent, ["session.update"]);
  await assert.rejects(testAsr({ ...profile, baseUrl: "ws://provider.example/" }, createSocket), /wss/);
});

test("connection and streaming failures never disclose provider credentials", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  let rejectHandshake = true;
  server.on("connection", (socket) => socket.on("message", (raw) => {
    if (!rejectHandshake && JSON.parse(raw.toString()).type === "session.update") {
      send(socket, { type: "session.updated" });
    } else {
      send(socket, { type: "error", error: { message: "provider error with mock-asr-key" } });
    }
  }));

  await assert.rejects(testAsr(profile, createSocket), (error: Error) => {
    assert.match(error.message, /无法连接或配置 ASR/);
    assert.doesNotMatch(error.message, /mock-asr-key/);
    return true;
  });
  rejectHandshake = false;
  const events: AsrEvent[] = [];
  const connection = await openAsr(profile, (event) => events.push(event), createSocket);
  connection.write(new Uint8Array([1, 2]));
  await connection.closed;
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  assert.doesNotMatch(events[0].text, /mock-asr-key/);
});

function seedPacket(sequence: number, payload: object, last = false): Buffer {
  const bytes = gzipSync(JSON.stringify(payload));
  const prefix = Buffer.from([0x11, last ? 0x93 : 0x91, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  prefix.writeInt32BE(sequence, 4);
  prefix.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([prefix, bytes]);
}

test("Seed tests the configuration ACK before readiness and uses modern default headers", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  let client: WebSocket | undefined;
  const received = new Promise<void>((resolve) => {
    server.on("connection", (socket, request) => {
      client = socket;
      assert.equal(request.headers["x-api-key"], profile.apiKey);
      assert.equal(request.headers["x-api-resource-id"], "volc.seedasr.sauc.duration");
      assert.match(String(request.headers["x-api-request-id"]), /^[\da-f-]+$/);
      assert.ok(!("x-api-app-key" in request.headers) && !("authorization" in request.headers));
      socket.on("message", (raw, binary) => {
        assert.equal(binary, true);
        const data = Buffer.from(raw as Buffer);
        assert.equal(data[1] >> 4, 1);
        const { audio, request } = JSON.parse(gunzipSync(data.subarray(12)).toString());
        assert.equal(audio.format, "pcm");
        assert.equal(audio.channel, 1);
        assert.equal(audio.rate, 16000);
        assert.equal(request.show_utterances, true);
        assert.equal(request.enable_nonstream, true);
        assert.equal(request.result_type, "single");
        resolve();
      });
    });
  });
  let ready = false;
  const opening = testAsr({ ...profile, protocol: "seed" }, (target, options) => {
    assert.equal(target, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
    return createSocket(target, options);
  }).then(() => { ready = true; });
  await received;
  assert.equal(ready, false);
  assert.ok(client);
  client.send(seedPacket(1, { code: 0 }));
  await opening;
  assert.equal(ready, true);
});

test("Seed preserves utterance IDs through drafting, skips cumulative finals, and drains the final frame", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  const events: AsrEvent[] = [];
  let finalPackets = 0;
  const first = { text: "这句话是分句定稿。", start_time: 100, end_time: 700, definite: true };
  server.on("connection", (socket, request) => {
    assert.equal(request.headers["x-api-resource-id"], "volc.seedasr.sauc.concurrent");
    socket.on("message", (raw, binary) => {
      assert.equal(binary, true);
      const data = Buffer.from(raw as Buffer);
      if (data[1] >> 4 === 1) {
        socket.send(seedPacket(1, { code: 0 }));
      } else if ((data[1] & 0x02) === 0) {
        assert.deepEqual(gunzipSync(data.subarray(12)), Buffer.from([1, 2, 3, 4]));
        socket.send(seedPacket(2, { result: { text: "这句话" } }));
        socket.send(seedPacket(2, { result: { utterances: [{ ...first, end_time: 500, text: "这句话是", definite: false }] } }));
        socket.send(seedPacket(2, { result: { utterances: [first] } }));
      } else {
        finalPackets++;
        assert.ok(data.readInt32BE(4) < 0);
        socket.send(seedPacket(-3, { result: { utterances: [first, { ...first, start_time: 900, end_time: 1500 }] } }, true));
      }
    });
  });
  const connection = await openAsr({
    ...profile, protocol: "seed", baseUrl: "wss://speech.example/stream", model: "volc.seedasr.sauc.concurrent",
  }, (event) => events.push(event), (target, options) => {
    assert.equal(target, "wss://speech.example/stream");
    return createSocket(target, options);
  });
  connection.write(new Uint8Array([1, 2, 3, 4]));
  connection.close();
  connection.close();
  await connection.closed;
  assert.equal(finalPackets, 1);
  assert.deepEqual(events, [
    { type: "partial", id: "seed-draft-1", text: "这句话" },
    { type: "partial", id: "seed-draft-1", text: "这句话是" },
    { type: "final", id: "seed-draft-1", text: first.text },
    { type: "final", id: "seed-900", text: first.text },
  ]);
});

test("Seed refuses application-level configuration errors with a credential-safe message", { timeout: 3_000 }, async (t) => {
  const { server, createSocket } = await localProvider(t);
  server.on("connection", (socket) => socket.once("message", () => {
    socket.send(seedPacket(1, { code: 45000001, message: "invalid mock-asr-key" }));
  }));
  await assert.rejects(testAsr({ ...profile, protocol: "seed" }, createSocket), (error: Error) => {
    assert.match(error.message, /无法连接或配置 ASR/);
    assert.doesNotMatch(error.message, /mock-asr-key/);
    return true;
  });
});
