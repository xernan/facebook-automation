import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardedStatus, contactLeadsToCsv, extractBanks, extractEmails, extractPhones, leadFromComment, leadFromConversation } from '../src/leads.js';
import { callTool, tools } from '../src/tools.js';
import { testCtx } from './helpers.js';

const tool = (name: string) => tools.find((t) => t.name === name)!;

describe('contact extraction', () => {
  it('finds PH mobile numbers in common formats and normalises them', () => {
    expect(extractPhones('call me 0917 123 4567 or +63 918-765-4321, 639191112222')).toEqual([
      '+639171234567',
      '+639187654321',
      '+639191112222',
    ]);
  });

  it('ignores ids, prices and landlines', () => {
    expect(extractPhones('order 1235234309673692, price 15000, tel 02 8123 4567, 09171234567890')).toEqual([]);
  });

  it('finds emails, lowercased and de-duplicated', () => {
    expect(extractEmails('Juan.Dela@Gmail.com pls, juan.dela@gmail.com')).toEqual(['juan.dela@gmail.com']);
  });
});

describe('credit card interest', () => {
  it('names the banks people ask about', () => {
    expect(extractBanks('pa-apply po sa BPI or Union Bank, rcbc flex din')).toEqual(['BPI', 'RCBC', 'UnionBank']);
    expect(extractBanks('apply po')).toEqual([]);
  });

  it('tells carded from first-time applicants', () => {
    expect(cardedStatus('carded po ako, 2 yrs na')).toBe('yes');
    expect(cardedStatus('may credit card na ako sa BDO')).toBe('yes');
    expect(cardedStatus('non-carded po')).toBe('no');
    expect(cardedStatus('wala pa akong credit card')).toBe('no');
    expect(cardedStatus('first time ko po')).toBe('no');
    expect(cardedStatus('interested po')).toBeUndefined();
  });
});

describe('lead builders', () => {
  const conv = {
    id: 't_1',
    updated_time: '2026-10-20T10:00:00+0000',
    participants: { data: [{ id: '111', name: 'CARD MAX' }, { id: '900', name: 'Ana' }] },
    messages: {
      data: [
        { message: 'Interested po sa BPI, non-carded. 09171234567', from: { id: '900' }, created_time: '2026-10-20T10:00:00+0000' },
        { message: 'Email us at sales@cardmax.ph', from: { id: '111' }, created_time: '2026-10-20T09:00:00+0000' },
      ],
    },
  };

  it('takes contact info only from the customer, not the Page', () => {
    const lead = leadFromConversation('111', conv)!;
    expect(lead).toMatchObject({ name: 'Ana', person_id: '900', phones: ['+639171234567'], emails: [], ref_id: 't_1' });
    expect(lead).toMatchObject({ banks: ['BPI'], carded: 'no' });
  });

  it('skips the Page own comments and hidden commenters', () => {
    expect(leadFromComment('111', '111_1', { id: 'c', from: { id: '111', name: 'CARD MAX' }, message: 'x' })).toBeUndefined();
    expect(leadFromComment('111', '111_1', { id: 'c', message: 'HM?' })).toBeUndefined();
  });

  it('guards CSV against formula injection', () => {
    const csv = contactLeadsToCsv([
      { source: 'comment', name: '=HYPERLINK("x")', emails: [], phones: [], banks: [], last_text: '', ref_id: 'c' },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('fb_messenger_leads', () => {
  const conversations = (n: number, start = 0) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t_${start + i}`,
      updated_time: new Date(Date.UTC(2026, 9, 20) - (start + i) * 86_400_000).toISOString(),
      participants: { data: [{ id: '111' }, { id: `9${start + i}`, name: `P${start + i}` }] },
      messages: { data: [{ message: (start + i) % 2 ? 'hm?' : 'ok 09171234567', from: { id: `9${start + i}` } }] },
    }));

  it('pages through conversations, stops at since, and exports CSV', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fbleads-'));
    let call = 0;
    const { ctx, calls } = testCtx(
      {},
      () => {
        call++;
        return call === 1
          ? { json: { data: conversations(3), paging: { next: 'x', cursors: { after: 'c1' } } } }
          : { json: { data: conversations(3, 3) } };
      },
      root,
    );
    const res: any = await callTool(
      tool('fb_messenger_leads'),
      { page_id: '111', since: '2026-10-16T00:00:00Z', only_with_contact: true, export_csv: true },
      ctx,
    );
    // 5 conversations are newer than since (days 0-4), the even ones shared a phone.
    expect(res.leads.map((l: any) => l.name)).toEqual(['P0', 'P2', 'P4']);
    expect(param(calls.at(-1)!, 'after')).toBe('c1');
    expect(readFileSync(res.csv_file, 'utf8')).toContain('+639171234567');
    expect(path.dirname(res.csv_file)).toBe(path.join(root, 'exports'));
  });

  it('stops at FB_LEADS_SCAN_MAX', async () => {
    const { ctx } = testCtx({ FB_LEADS_SCAN_MAX: '2' }, () => ({
      json: { data: conversations(3), paging: { next: 'x', cursors: { after: 'c1' } } },
    }));
    const res: any = await callTool(tool('fb_messenger_leads'), { page_id: '111' }, ctx);
    expect(res.scanned).toBe(2);
    expect(res.count).toBe(2);
  });
});

describe('fb_comment_leads', () => {
  it('filters by keyword, skips the Page own replies', async () => {
    const { ctx } = testCtx({}, (c) =>
      c.url.pathname.endsWith('/111/posts')
        ? { json: { data: [{ id: '111_1' }] } }
        : {
            json: {
              data: [
                { id: 'c1', from: { id: '5', name: 'Ben' }, message: 'HM po? 09181234567' },
                { id: 'c2', from: { id: '6', name: 'Cy' }, message: 'nice' },
                { id: 'c3', from: { id: '111', name: 'CARD MAX' }, message: 'hm sent you a PM' },
              ],
            },
          },
    );
    const res: any = await callTool(tool('fb_comment_leads'), { page_id: '111', keywords: ['hm'] }, ctx);
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0]).toMatchObject({ name: 'Ben', ref_id: 'c1', post_id: '111_1', phones: ['+639181234567'] });
  });

  it('refuses a post of another page', async () => {
    const { ctx } = testCtx();
    await expect(callTool(tool('fb_comment_leads'), { page_id: '111', post_id: '222_1' }, ctx)).rejects.toThrow(/does not belong/);
  });
});

function param(c: { url: URL }, k: string) {
  return c.url.searchParams.get(k);
}
