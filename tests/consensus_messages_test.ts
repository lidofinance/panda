import assert from "node:assert/strict";
import { ConsensusMessages, replayConsensusMessages } from "../src/consensus_messages.ts";
import { deadline } from "../src/http.ts";

const ptc = "/eth/v1/beacon/pool/payload_attestations";

Deno.test("snapshot retains original signed Beacon submissions without changing forwarding", async () => {
  const calls: { body: Uint8Array; headers: Headers }[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    calls.push({ body: new Uint8Array(await request.arrayBuffer()), headers: request.headers });
    return new Response("native reply", { headers: { "x-native": "untouched" } });
  });
  try {
    const buffer = new ConsensusMessages(() => 3);
    const body = '[ { "validator_index":"1", "data":{"slot":"3"}, "signature":"0x1234" } ]';
    const headers: [string, string][] = [
      ["content-type", "application/json"],
      ["eth-consensus-version", "gloas"],
    ];
    const response = await buffer.forward(
      new Request("http://panda" + ptc, { method: "POST", body, headers }),
      `http://127.0.0.1:${server.addr.port}`,
    );
    assert.equal(await response.text(), "native reply");
    assert.equal(response.headers.get("x-native"), "untouched");
    assert.deepEqual(calls[0].body, new TextEncoder().encode(body));
    assert.equal(calls[0].headers.get("eth-consensus-version"), "gloas");
    assert.deepEqual(buffer.snapshot(), [{
      path: ptc,
      headers,
      body: [...new TextEncoder().encode(body)],
    }]);
  } finally {
    await server.shutdown();
  }
});

function publication(path = ptc, body = '[{"data":{"slot":"3"}}]') {
  return new Request("http://panda" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function receiver(
  handle: (request: Request) => Response | Promise<Response>,
  test: (url: string) => Promise<void>,
) {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handle);
  try {
    await test(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("overlapping submissions retain import order and cannot be snapshotted in flight", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const received: string[] = [];
  await receiver(async (request) => {
    received.push(await request.text());
    if (received.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return new Response(null);
  }, async (url) => {
    const buffer = new ConsensusMessages(() => 3);
    const first = buffer.forward(publication(), url);
    await entered.promise;
    const second = buffer.forward(
      publication(ptc, '[{"data":{"slot":"3"},"signature":"second"}]'),
      url,
    );
    try {
      assert.throws(() => buffer.snapshot(), /in flight/);
      assert.equal(received.length, 1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    assert.deepEqual(
      buffer.snapshot().map((entry) => new TextDecoder().decode(Uint8Array.from(entry.body))),
      received,
    );
    const copy = buffer.snapshot();
    copy[0].body[0] = 0;
    assert.notEqual(buffer.snapshot()[0].body[0], 0, "caller mutated captured evidence");
  });
});

Deno.test("partial native errors preserve the response but prevent a lossless snapshot", async () => {
  await receiver(() => new Response("one item failed", { status: 400 }), async (url) => {
    const buffer = new ConsensusMessages(() => 3);
    const response = await buffer.forward(publication(), url);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "one item failed");
    assert.throws(() => buffer.snapshot(), /Unresolved.*400/);
  });
});

Deno.test("a lost response after native acceptance prevents capture after the queue drains", async () => {
  const accepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = '[{"data":{"slot":"3"},"signature":"signed-original"}]';
  let effects = 0;
  await receiver(async (request) => {
    assert.equal(await request.text(), body);
    effects++;
    accepted.resolve();
    await release.promise;
    return new Response(null);
  }, async (url) => {
    const buffer = new ConsensusMessages(() => 3);
    const abort = new AbortController();
    const pending = buffer.forward(
      new Request(publication(ptc, body), { signal: abort.signal }),
      url,
    );
    const rejected = assert.rejects(pending);
    try {
      await deadline(accepted.promise, 1_000, "upstream accepts signed body");
      assert.equal(effects, 1, "request did not reach the upstream before losing its response");
      abort.abort(new Error("test lost native response"));
      await deadline(rejected, 1_000, "lost response rejects forwarding");
      assert.throws(() => buffer.snapshot(), /Unresolved consensus submission: response lost/);
    } finally {
      abort.abort();
      release.resolve();
      await rejected;
    }
  });
});

Deno.test("a stalled upload times out before forwarding and releases the consensus queue", async () => {
  const previous = Deno.env.get("PANDA_TIMEOUT_MS");
  Deno.env.set("PANDA_TIMEOUT_MS", "25");
  let cancelled = false;
  let calls = 0;
  try {
    await receiver(() => {
      calls++;
      return new Response(null);
    }, async (url) => {
      const buffer = new ConsensusMessages(() => 3);
      const request = new Request("http://panda" + ptc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("["));
          },
          cancel() {
            cancelled = true;
          },
        }),
      });
      await assert.rejects(deadline(buffer.forward(request, url), 100, "test upload budget"));
      assert.equal(cancelled, true, "capture did not cancel the stalled body");
      await deadline(buffer.forward(publication(), url), 200, "queue recovery");
      assert.equal(calls, 1);
      assert.equal(buffer.snapshot().length, 1);
    });
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_TIMEOUT_MS");
    else Deno.env.set("PANDA_TIMEOUT_MS", previous);
  }
});

Deno.test("empty native publications do not exhaust capture storage", async () => {
  let calls = 0;
  await receiver(() => {
    calls++;
    return new Response(null);
  }, async (url) => {
    const buffer = new ConsensusMessages(() => 3, 100);
    for (let i = 0; i < 4; i++) await buffer.forward(publication(ptc, "[]"), url);
    assert.equal(calls, 4);
    assert.deepEqual(buffer.snapshot(), []);
  });
});

Deno.test("retention keeps previous-epoch duplicate evidence and releases expired records", async () => {
  let slot = 32;
  const buffer = new ConsensusMessages(() => slot);
  const path = "/eth/v2/beacon/pool/attestations";
  await receiver(() => new Response(null), async (url) => {
    for (const value of [32, 63]) {
      slot = value;
      await buffer.forward(
        publication(
          path,
          JSON.stringify([{
            attester_index: "0",
            data: { slot: String(value), target: { epoch: "1" } },
          }]),
        ),
        url,
      );
    }
    slot = 64;
    assert.throws(() => buffer.snapshot(), /Ambiguous/);
    slot = 96;
    assert.deepEqual(buffer.snapshot(), [], "obsolete epoch prevented future snapshots");
  });
});

Deno.test("attestation ambiguity keys use numeric identity without altering forwarded fields", async () => {
  const buffer = new ConsensusMessages(() => 64);
  const path = "/eth/v2/beacon/pool/attestations";
  await receiver(() => new Response(null), async (url) => {
    await buffer.forward(
      publication(
        path,
        JSON.stringify([
          { attester_index: "0", data: { slot: "32", target: { epoch: "1" } } },
          { attester_index: "00", data: { slot: "63", target: { epoch: "01" } } },
        ]),
      ),
      url,
    );
    assert.throws(() => buffer.snapshot(), /Ambiguous/);
  });
});

Deno.test("different same-slot attestation contents make an HTTP 200 batch unsafe to replay", async () => {
  const path = "/eth/v2/beacon/pool/attestations";
  const body = JSON.stringify(["unknown-first", "known-second"].map((root) => ({
    attester_index: "0",
    data: { slot: "3", beacon_block_root: root, target: { epoch: "0" } },
    signature: `signature-for-${root}`,
  })));
  const buffer = new ConsensusMessages(() => 3);
  await receiver(async (request) => {
    assert.equal(await request.text(), body, "forwarding changed the original batch");
    // Native processing may queue an unknown head/envelope, import the later item first, then
    // report the first as AlreadyKnown. HTTP 200 alone does not identify the imported winner.
    return new Response(null);
  }, async (url) => {
    assert.equal((await buffer.forward(publication(path, body), url)).status, 200);
    assert.throws(() => buffer.snapshot(), /Ambiguous.*attestation/);
  });
  let calls = 0;
  await receiver(() => {
    calls++;
    return new Response(null);
  }, async (url) => {
    await assert.rejects(
      replayConsensusMessages(
        [{
          path,
          headers: [["content-type", "application/json"]],
          body: [...new TextEncoder().encode(body)],
        }],
        url,
        3,
      ),
      /Ambiguous.*attestation/,
    );
    assert.equal(calls, 0, "ambiguous replay changed the candidate before preflight failed");
  });
});

Deno.test("identical repeated attestations remain forwarded, captured, and replayed", async () => {
  const path = "/eth/v2/beacon/pool/attestations";
  const attestation = {
    attester_index: "0",
    data: { slot: "3", beacon_block_root: "same-root", target: { epoch: "0" } },
    signature: "same-signature",
  };
  const body = JSON.stringify([attestation, attestation]);
  const buffer = new ConsensusMessages(() => 3);
  await receiver(async (request) => {
    assert.equal(await request.text(), body);
    return new Response(null);
  }, async (url) => {
    await buffer.forward(publication(path, body), url);
    await buffer.forward(publication(path, body), url);
  });
  const saved = buffer.snapshot();
  assert.equal(saved.length, 2);
  const replayed: unknown[] = [];
  await receiver(async (request) => {
    replayed.push(await request.json());
    return new Response(null);
  }, (url) => replayConsensusMessages(saved, url, 3));
  assert.deepEqual(replayed, Array(4).fill([attestation]));
});

Deno.test("same-slot sync contents with head-dependent HTTP 200 outcomes prevent replay", async () => {
  const path = "/eth/v1/beacon/pool/sync_committees";
  const body = JSON.stringify(["head-at-arrival", "head-at-snapshot"].map((root) => ({
    slot: "3",
    validator_index: "0",
    beacon_block_root: root,
    signature: `signature-for-${root}`,
  })));
  const buffer = new ConsensusMessages(() => 3);
  await receiver(async (request) => {
    assert.equal(await request.text(), body);
    // Native sync verification ignores a second root unless it is the current head. That head
    // may change before the cut, so replay can import an originally ignored HTTP 200 item.
    return new Response(null);
  }, async (url) => {
    assert.equal((await buffer.forward(publication(path, body), url)).status, 200);
    assert.throws(() => buffer.snapshot(), /Ambiguous.*sync/);
  });
  let calls = 0;
  await receiver(() => {
    calls++;
    return new Response(null);
  }, async (url) => {
    await assert.rejects(
      replayConsensusMessages(
        [{
          path,
          headers: [["content-type", "application/json"]],
          body: [...new TextEncoder().encode(body)],
        }],
        url,
        3,
      ),
      /Ambiguous.*sync/,
    );
    assert.equal(calls, 0);
  });
});

Deno.test("identical sync repeats are preserved without colliding with attestation identities", async () => {
  const sync = "/eth/v1/beacon/pool/sync_committees";
  const single = "/eth/v2/beacon/pool/attestations";
  const syncVote = { slot: "0", validator_index: "0", signature: "same-sync-signature" };
  const singleVote = { attester_index: "0", data: { slot: "0", target: { epoch: "0" } } };
  const buffer = new ConsensusMessages(() => 0);
  await receiver(() => new Response(null), async (url) => {
    await buffer.forward(publication(single, JSON.stringify([singleVote])), url);
    await buffer.forward(publication(sync, JSON.stringify([syncVote, syncVote])), url);
  });
  const replayed: unknown[] = [];
  await receiver(async (request) => {
    replayed.push(await request.json());
    return new Response(null);
  }, (url) => replayConsensusMessages(buffer.snapshot(), url, 0));
  assert.deepEqual(replayed, [[singleVote], [syncVote], [syncVote]]);
});

Deno.test("capture refuses oversized input before forwarding and leaves prior evidence intact", async () => {
  let calls = 0;
  await receiver(() => {
    calls++;
    return new Response(null);
  }, async (url) => {
    const buffer = new ConsensusMessages(() => 3, 180);
    await buffer.forward(publication(), url);
    const before = buffer.snapshot();
    await assert.rejects(buffer.forward(publication(ptc, " ".repeat(200)), url), /capacity/);
    assert.equal(calls, 1);
    assert.deepEqual(buffer.snapshot(), before);
  });
});

Deno.test("tail replay keeps original signed fields and eligible old singles", async () => {
  const buffer = new ConsensusMessages(() => 4);
  const singles = "/eth/v2/beacon/pool/attestations";
  const sync = "/eth/v1/beacon/pool/sync_committees";
  await receiver(() => new Response(null), async (url) => {
    await buffer.forward(
      publication(
        sync,
        '[{"slot":"3","validator_index":"0"},{"slot":"4","validator_index":"0"}]',
      ),
      url,
    );
    await buffer.forward(
      publication(
        singles,
        JSON.stringify([0, 1, 4].map((slot) => ({
          attester_index: String(slot),
          data: { slot: String(slot), target: { epoch: "0" } },
          signature: "0xsigned",
        }))),
      ),
      url,
    );
  });
  const received: unknown[] = [];
  await receiver(async (request) => {
    received.push(await request.json());
    return new Response(null);
  }, (url) => replayConsensusMessages(buffer.snapshot(), url, 4));
  assert.deepEqual(received, [
    [{ slot: "4", validator_index: "0" }],
    ...[1, 4].map((
      slot,
    ) => [{
      attester_index: String(slot),
      data: { slot: String(slot), target: { epoch: "0" } },
      signature: "0xsigned",
    }]),
  ]);
});

Deno.test("SSZ payload replay preserves original signed bytes and rejects unsafe slots before forwarding", async () => {
  const bytes = new Uint8Array(146 * 2).fill(9);
  for (let n = 0; n < 2; n++) {
    new DataView(bytes.buffer).setBigUint64(n * 146 + 40, BigInt(n + 2), true);
  }
  const request = (body: Uint8Array) =>
    new Request("http://panda" + ptc, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "eth-consensus-version": "gloas" },
      body: new Uint8Array(body),
    });
  const buffer = new ConsensusMessages(() => 3);
  let calls = 0;
  await receiver(() => {
    calls++;
    return new Response(null);
  }, async (url) => {
    await buffer.forward(request(bytes), url);
    const invalid = bytes.slice(0, 146);
    new DataView(invalid.buffer).setBigUint64(40, 2n ** 63n, true);
    await assert.rejects(buffer.forward(request(invalid), url), /Unsafe/);
    assert.equal(calls, 1);
  });
  const replayed: Uint8Array[] = [];
  await receiver(async (request) => {
    replayed.push(new Uint8Array(await request.arrayBuffer()));
    assert.equal(request.headers.get("eth-consensus-version"), "gloas");
    return new Response(null);
  }, (url) => replayConsensusMessages(buffer.snapshot(), url, 3));
  assert.deepEqual(replayed, [bytes.slice(146)]);
});

for (
  const [name, path, contentType] of [
    ["single attestation", "/eth/v2/beacon/pool/attestations", "application/json"],
    ["sync message", "/eth/v1/beacon/pool/sync_committees", "application/json"],
    ["JSON payload attestation", ptc, "application/json"],
    ["SSZ payload attestation", ptc, "application/octet-stream"],
  ]
) {
  Deno.test(`future ${name} prevents capture and replay until the saved clock catches up`, async () => {
    let slot = 3;
    const buffer = new ConsensusMessages(() => slot);
    // Put a current vote before the future vote: replay must preflight the whole capture before
    // making even the first candidate write. These are adapter fixtures, not native-valid votes.
    const body = contentType === "application/octet-stream"
      ? new Uint8Array(146 * 2).fill(9)
      : new TextEncoder().encode(JSON.stringify([3, 4].map((value) => ({
        slot: String(value),
        attester_index: String(value),
        validator_index: String(value),
        data: { slot: String(value), target: { epoch: "0" } },
        signature: `signed-${value}`,
      }))));
    if (contentType === "application/octet-stream") {
      new DataView(body.buffer).setBigUint64(40, 3n, true);
      new DataView(body.buffer).setBigUint64(146 + 40, 4n, true);
    }
    const headers: [string, string][] = [["content-type", contentType]];
    const saved = [{ path, headers, body: [...body] }];
    let calls = 0;
    await receiver(async (request) => {
      calls++;
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), body);
      return new Response("native response");
    }, async (url) => {
      const response = await buffer.forward(
        new Request("http://panda" + path, { method: "POST", headers, body }),
        url,
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "native response");
      assert.throws(() => buffer.snapshot(), /Future consensus message/);
      await assert.rejects(replayConsensusMessages(saved, url, slot), /Future consensus message/);
      assert.equal(calls, 1, "future replay wrote to the candidate before preflight failed");
    });
    slot = 4;
    assert.deepEqual(buffer.snapshot(), saved, "temporary future refusal poisoned later capture");
    const replayed: Uint8Array[] = [];
    await receiver(async (request) => {
      replayed.push(new Uint8Array(await request.arrayBuffer()));
      return new Response(null);
    }, (url) => replayConsensusMessages(buffer.snapshot(), url, slot));
    assert.equal(replayed.length, path.includes("/attestations") ? 2 : 1);
  });
}

Deno.test("replay refuses ambiguous epoch duplicates before posting and stops on native rejection", async () => {
  const buffer = new ConsensusMessages(() => 3);
  await receiver(() => new Response(null), async (url) => {
    await buffer.forward(
      publication(
        "/eth/v2/beacon/pool/attestations",
        JSON.stringify([1, 2].map((slot) => ({
          attester_index: "0",
          data: { slot: String(slot), target: { epoch: "0" } },
        }))),
      ),
      url,
    );
  });
  let calls = 0;
  await receiver(() => {
    calls++;
    return new Response("rejected", { status: 500 });
  }, async (url) => {
    assert.throws(() => buffer.snapshot(), /Ambiguous/, "refuse before stopping a healthy source");
    assert.equal(calls, 0);
    const messages = new ConsensusMessages(() => 3);
    await receiver(() => new Response(null), async (source) => {
      await messages.forward(publication(), source);
      await messages.forward(publication(), source);
    });
    await assert.rejects(replayConsensusMessages(messages.snapshot(), url, 3), /500 rejected/);
    assert.equal(calls, 1);
  });
});
