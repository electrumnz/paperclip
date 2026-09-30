import { describe, expect, it } from "vitest";
import { classifyAcpxOutputRejection } from "./output-rejection.js";

// The exact output of the run that motivated this seam: the Codex CLI's
// fallback-metadata warning, then the provider's 400 forwarded as assistant
// text. The turn ended `end_turn` and the run was recorded `succeeded`.
const CODEX_MODEL_REJECTION = [
  "Warning: Model metadata for `claude-haiku-4-5` not found. Defaulting to fallback metadata...",
  JSON.stringify({
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account.",
    },
  }),
];

describe("classifyAcpxOutputRejection", () => {
  it("fails the observed Codex model rejection as model_not_found", () => {
    const rejection = classifyAcpxOutputRejection({
      outputSegments: CODEX_MODEL_REJECTION,
      sawToolActivity: false,
    });

    expect(rejection).not.toBeNull();
    expect(rejection?.kind).toBe("model_rejected");
    expect(rejection?.errorCode).toBe("model_not_found");
    expect(rejection?.message).toContain(
      "The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(rejection?.message).toContain("400");
  });

  it("classifies the rejection when the warning and payload arrive in one segment", () => {
    // Text deltas are concatenated before classification, so the segment
    // boundary must not change the outcome.
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [CODEX_MODEL_REJECTION.join("\n")],
      sawToolActivity: false,
    });

    expect(rejection?.errorCode).toBe("model_not_found");
  });

  it("classifies a model rejection carrying no envelope `type`", () => {
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [
        JSON.stringify({
          status: 404,
          error: { type: "invalid_request_error", message: "The model `gpt-9` does not exist." },
        }),
      ],
      sawToolActivity: false,
    });

    expect(rejection?.errorCode).toBe("model_not_found");
  });

  it("does not classify a turn that called a tool", () => {
    // The strongest false-positive guard: an agent working on this very bug
    // quotes the payload, and its run must stay a success.
    expect(
      classifyAcpxOutputRejection({
        outputSegments: CODEX_MODEL_REJECTION,
        sawToolActivity: true,
      }),
    ).toBeNull();
  });

  it("does not classify a zero-tool-call turn that explains the payload in prose", () => {
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [
        "Here is what that provider response means.\n",
        JSON.stringify({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: "The 'x' model is not supported." },
        }),
        "\nYour seat is pointed at a model the adapter's provider will not serve.",
      ],
      sawToolActivity: false,
    });

    expect(rejection).toBeNull();
  });

  it("does not classify an ordinary no-op heartbeat", () => {
    // 139 of the fleet's succeeded runs made no tool calls. Most are
    // legitimate no-ops, and the tool count alone must never fail them.
    expect(
      classifyAcpxOutputRejection({
        outputSegments: ["Nothing to do this heartbeat; the board is quiet."],
        sawToolActivity: false,
      }),
    ).toBeNull();
    expect(
      classifyAcpxOutputRejection({ outputSegments: [], sawToolActivity: false }),
    ).toBeNull();
    expect(
      classifyAcpxOutputRejection({ outputSegments: ["   \n\n  "], sawToolActivity: false }),
    ).toBeNull();
  });

  it("does not classify a JSON payload that is not an error envelope", () => {
    expect(
      classifyAcpxOutputRejection({
        outputSegments: [JSON.stringify({ status: 200, type: "result", ok: true })],
        sawToolActivity: false,
      }),
    ).toBeNull();
  });

  it("records a non-model provider error payload as an ordinary adapter failure", () => {
    // The weaker general guard: an error payload and nothing else is not a
    // success, but it is not a permanent model problem either.
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [
        JSON.stringify({
          type: "error",
          status: 429,
          error: { type: "rate_limit_error", message: "Rate limit exceeded." },
        }),
      ],
      sawToolActivity: false,
    });

    expect(rejection?.kind).toBe("error_payload_only");
    expect(rejection?.errorCode).toBe("adapter_failed");
    expect(rejection?.message).toContain("Rate limit exceeded.");
  });

  it("does not call a 5xx a model rejection", () => {
    // A 500 whose text happens to mention the model is the provider failing,
    // not refusing. Recording it as `model_not_found` would make a transient
    // outage look like a permanent configuration fault.
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [
        JSON.stringify({
          type: "error",
          status: 503,
          error: { type: "overloaded_error", message: "The model is not available right now." },
        }),
      ],
      sawToolActivity: false,
    });

    expect(rejection?.errorCode).toBe("adapter_failed");
  });

  it("does not trip on the fallback-metadata warning alone", () => {
    // The warning line precedes the real rejection but is not itself one: the
    // CLI prints it and then proceeds happily on a servable model.
    expect(
      classifyAcpxOutputRejection({
        outputSegments: [
          "Warning: Model metadata for `claude-haiku-4-5` not found. Defaulting to fallback metadata...",
        ],
        sawToolActivity: false,
      }),
    ).toBeNull();
  });

  it("tolerates a braced provider message and a fenced payload", () => {
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [
        "```json\n",
        JSON.stringify({
          status: 400,
          error: {
            type: "invalid_request_error",
            message: "model `a{b}c` is not supported for this account",
          },
        }),
        "\n```",
      ],
      sawToolActivity: false,
    });

    expect(rejection?.errorCode).toBe("model_not_found");
  });

  it("ignores unparseable brace noise instead of classifying on it", () => {
    expect(
      classifyAcpxOutputRejection({
        outputSegments: ['{"error": unterminated'],
        sawToolActivity: false,
      }),
    ).toBeNull();
  });

  it("does not reclassify an error the agent is quoting mid-sentence", () => {
    // Regression: the fleet's own `spawn-smoke` test
    // ("preserves ordinary assistant text even when it resembles a provider
    // error") pins that error-*shaped* assistant prose stays a success. The
    // quoted fragment carries no status and does not type itself `error`, so it
    // is not a payload the provider relayed — it is a sentence that contains
    // one. The residue rule alone let this through, because the leading
    // `Warning:` reads like provider prose.
    expect(
      classifyAcpxOutputRejection({
        outputSegments: [
          'Warning: quoted example follows. {"error":{"type":"invalid_request_error","message":"example only"}}',
        ],
        sawToolActivity: false,
      }),
    ).toBeNull();
  });

  it("still reclassifies a relayed payload that follows a provider warning", () => {
    // The same `Warning:` prose, but the payload declares itself with a status
    // and `type: "error"`. The segments concatenate with no separator, exactly
    // as ACP delivers them, so the discriminator cannot be line placement — it
    // is whether the payload identifies itself as the provider's own.
    const rejection = classifyAcpxOutputRejection({
      outputSegments: [
        "Warning: Model metadata for `claude-haiku-4-5` not found. Defaulting to fallback metadata...",
        JSON.stringify({
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            message: "The 'claude-haiku-4-5' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      ],
      sawToolActivity: false,
    });

    expect(rejection?.errorCode).toBe("model_not_found");
  });
});
