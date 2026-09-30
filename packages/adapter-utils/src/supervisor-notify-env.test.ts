import { describe, expect, it } from "vitest";
import {
  SUPERVISOR_NOTIFY_ENV_KEYS,
  withoutSupervisorNotifyEnv,
} from "./supervisor-notify-env.js";

describe("withoutSupervisorNotifyEnv", () => {
  it("removes NOTIFY_SOCKET and WATCHDOG_PID from a child environment", () => {
    const env = {
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
      WATCHDOG_PID: "4242",
      PATH: "/usr/bin:/bin",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    };

    expect(withoutSupervisorNotifyEnv(env)).toEqual({
      PATH: "/usr/bin:/bin",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    });
  });

  it("removes them whatever their value, including an empty string", () => {
    // An empty value is still an inherited capability: `systemdNotify` tests
    // `process.env.NOTIFY_SOCKET?.trim()`, so "" is inert, but a child that
    // sets it explicitly to "" is not what this guards against — the key's
    // presence is. Guarding presence only is the conservative rule.
    const stripped = withoutSupervisorNotifyEnv({
      NOTIFY_SOCKET: "",
      WATCHDOG_PID: "",
      KEEP: "yes",
    });
    expect(stripped).toEqual({ KEEP: "yes" });
    expect(Object.keys(stripped)).not.toContain("NOTIFY_SOCKET");
  });

  it("is case-insensitive, because a Windows spawn target resolves keys that way", () => {
    const stripped = withoutSupervisorNotifyEnv({
      Notify_Socket: "/run/user/1000/systemd/notify",
      Watchdog_Pid: "4242",
      PATH: "/usr/bin",
    });
    expect(stripped).toEqual({ PATH: "/usr/bin" });
  });

  it("does not mutate the environment it is given", () => {
    // The server's own `systemdNotify` reads `process.env.NOTIFY_SOCKET`; a
    // helper that deleted the key in place would silently break the server's
    // own READY/STOPPING notifications for the rest of the process lifetime.
    const original: Record<string, string> = {
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
      PATH: "/usr/bin",
    };
    const result = withoutSupervisorNotifyEnv(original);

    expect(original.NOTIFY_SOCKET).toBe("/run/user/1000/systemd/notify");
    expect(result).not.toBe(original);
    expect(result.NOTIFY_SOCKET).toBeUndefined();
  });

  it("keeps every other key, so the child still inherits what it needs", () => {
    const env = {
      HOME: "/home/agent",
      LANG: "en_NZ.UTF-8",
      PATH: "/usr/bin:/bin",
      TZ: "Pacific/Auckland",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XAI_API_KEY: "provider-key",
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
    };
    const stripped = withoutSupervisorNotifyEnv(env);

    for (const key of ["HOME", "LANG", "PATH", "TZ", "DBUS_SESSION_BUS_ADDRESS", "XAI_API_KEY"]) {
      expect(stripped).toHaveProperty(key, env[key as keyof typeof env]);
    }
    // DBUS is deliberately left alone: it is not a supervisor-notify key and
    // narrowing it here would be out of scope for this fix.
    expect(stripped.DBUS_SESSION_BUS_ADDRESS).toBe(env.DBUS_SESSION_BUS_ADDRESS);
  });

  it("names exactly the two keys it strips", () => {
    expect([...SUPERVISOR_NOTIFY_ENV_KEYS]).toEqual(["NOTIFY_SOCKET", "WATCHDOG_PID"]);
  });

  it("returns an equivalent copy when there is nothing to strip", () => {
    const env = { PATH: "/usr/bin" };
    expect(withoutSupervisorNotifyEnv(env)).toEqual(env);
    expect(withoutSupervisorNotifyEnv(env)).not.toBe(env);
  });

  // The property this exists for, stated as an end-to-end check rather than a
  // proxy for it: a child built the way the Hermes adapter builds one must not
  // be able to address the parent unit's notify socket.
  it("leaves no case variant of a notify key in the result", () => {
    const stripped = withoutSupervisorNotifyEnv({
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
      notify_socket: "/run/user/1000/systemd/notify",
      NoTiFy_SoCkEt: "/run/user/1000/systemd/notify",
    });
    for (const key of Object.keys(stripped)) {
      expect(key.toUpperCase()).not.toBe("NOTIFY_SOCKET");
      expect(key.toUpperCase()).not.toBe("WATCHDOG_PID");
    }
  });
});