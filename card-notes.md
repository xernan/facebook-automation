Owner rules on which cards count as a bank credit card (read by the AI on every run; researched 2026-11-03).

1. COUNTS, no question: credit cards from BDO, BPI, Metrobank, RCBC, EastWest, China Bank, PNB, Security Bank, UnionBank (and old Citi cards), HSBC, AUB, Maybank, PSBank, Bank of Commerce (BankCom).

2. DEBIT ONLY, these have no credit card: GoTyme, Tonik, SeaBank, MariBank, CIMB, DBP, UNO Digital Bank, GCash (GCredit is a credit line, not a card), ShopeePay, Overseas Filipino Bank, Netbank.
   Do not ask about it. Say it plainly, for example: "Debit card po ang GoTyme, hindi credit card." Then go back to the bank question (fb_flow_answer kind="question"). If that was their only card and they say they have no other, pass no_credit_card=true.

3. BOTH, ask once: these give out debit/ATM cards AND credit cards, so ask in plain words (owner: people only see the difference when asked about ATM):
   "ATM card ba yan (pang-withdraw ng sarili mong pera)? O credit card (may credit limit at monthly bill na binabayaran mo)?"
   - Landbank (most people have the ATM; a Landbank Mastercard credit card exists)
   - Maya (Maya debit card and wallet do not count; a Maya credit card does)
   - Home Credit (loans and pay-later do not count; Home Credit has a BSP license for a credit card)
   - UnionDigital
   Send the question with fb_send_message, then fb_flow_answer kind="asked". Pass the card in cards only after they say it is a credit card.

4. NEVER COUNTS: Atome, any debit or ATM card, prepaid cards, pay-later (BillEase, SPayLater, Lazada PayLater, Maya Pay in 4), loan accounts.

5. A name not in these lists: WebSearch "<name> credit card Philippines" first. If it has no credit card, treat it as list 2. If it has both, list 3. Only a real bank credit card counts.
