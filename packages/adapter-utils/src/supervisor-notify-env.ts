/**
 * Environment keys that describe **this** process's relationship with its own
 * supervisor, and must never be passed to a process it spawns.
 *
 * `NOTIFY_SOCKET` names the notify socket of the systemd unit this process
 * belongs to. Inheriting it hands every descendant — agent worker, test, scratch
 * process — the ability to write a datagram to the **parent unit's** socket, and
 * with `NotifyAccess=all` systemd attributes that datagram to the unit. A
 * descendant that sends `STOPPING=1` therefore moves the unit into
 * `deactivating/stop-sigterm` **without any signal reaching the main process**.
 * The main process then never runs its own shutdown path, emits none of its
 * teardown log lines, and the supervisor eventually SIGKILLs the whole control
 * group at `TimeoutStopSec`, taking every undrained child worker with it.
 *
 * That is the KEE-1149 stop-timeout signature. The sending process can be an
 * innocent bystander whose tool simply happens to call `systemd-notify`; the
 * message is what does the damage, so the fix belongs at the inheritance
 * boundary rather than in any one sender.
 *
 * `WATCHDOG_PID` is the same class of key: it names the process systemd expects
 * to send watchdog pings for, so a descendant must not act on it either.
 *
 * @see KEE-1149
 */
export const SUPERVISOR_NOTIFY_ENV_KEYS = ["NOTIFY_SOCKET", "WATCHDOG_PID"] as const;

/**
 * Strip {@link SUPERVISOR_NOTIFY_ENV_KEYS} from a child environment.
 *
 * Call this on the environment being handed to a spawned process. Nothing else
 * is filtered — the child still inherits PATH, the Paperclip variables and
 * everything else it had before.
 *
 * Keys are matched case-insensitively because a spawn target on Windows
 * inherits environment keys case-insensitively, so `Notify_Socket` would
 * resolve the same variable there.
 *
 * @param env environment about to be given to a child; not mutated
 */
export function withoutSupervisorNotifyEnv<T extends Record<string, unknown>>(
  env: T,
): T {
  const stripped = { ...env } as T;
  for (const key of Object.keys(stripped)) {
    if ((SUPERVISOR_NOTIFY_ENV_KEYS as readonly string[]).includes(key.toUpperCase())) {
      delete stripped[key];
    }
  }
  return stripped;
}