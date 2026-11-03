// When this server last sent a Messenger message to each person (fb_send_message), so fb_flow_answer
// kind="asked" can check that Claude really asked something before it marks their messages handled.
const lastSent = new Map<string, number>();

export function noteSent(psid: string, at = Date.now()): void {
  lastSent.set(psid, at);
}

/** True when a message went to this person within the last `withinMs`. */
export function sentRecently(psid: string, withinMs: number, now = Date.now()): boolean {
  const at = lastSent.get(psid);
  return at !== undefined && now - at <= withinMs;
}
