# Facebook Automation para kay Claude

Starter kit ito para mapamahalaan ni Claude ang mga **Facebook Page** mo gamit ang
**official Meta Graph API (v26.0)**. Walang bot sa browser at walang password login, kaya
hindi ka mab-ban dahil sa automation.

## Kaya ni Claude

| Bahagi | Mga tool |
|---|---|
| Pages | `fb_list_pages`, `fb_get_page`, `fb_update_page_info` |
| Posts | `fb_list_posts` (pati scheduled), `fb_get_post`, `fb_create_post`, `fb_create_photo_post`, `fb_create_video_post`, `fb_update_post`, `fb_delete_post` |
| Pag-schedule | `scheduled_time` sa lahat ng create-post tool (10 minuto hanggang 30 araw) |
| Comments | `fb_list_comments`, `fb_reply_comment`, `fb_hide_comment`, `fb_delete_comment` |
| Messenger | `fb_list_conversations`, `fb_get_messages`, `fb_send_message` (sagot sa loob ng 24 oras, o private reply sa nag-comment) |
| Insights | `fb_page_insights`, `fb_post_insights` |
| Reviews | `fb_list_reviews` |
| **Leads** | `fb_list_lead_forms`, `fb_get_leads` (puwedeng i-export sa CSV sa `exports/`) |
| Iba pa | `fb_graph_get`: read-only access sa kahit anong Graph API endpoint |

Halimbawang utos kay Claude:
- "Gumawa ka ng 5 post para sa promo next week, i-schedule tuwing 9am."
- "Sagutin mo lahat ng tanong sa comments ng huling post, at i-private reply ang nagtanong ng presyo."
- "I-export mo ang mga bagong leads ngayong linggo sa CSV."
- "Anong post ang may pinakamaraming engagement nitong buwan?"

## Hindi kaya (bawal o wala sa official API)

- Mag-post sa **personal profile** o sa **Groups**. Tinanggal ito ng Meta noong 2024.
- Mag-scrape ng group members, magpadala ng friend request, o mag-message sa taong hindi
  pa nagme-message sa Page (bawal ang cold DM).
- Gumawa ng **Ads** at mag-manage ng **Instagram**. Posible ito sa API pero wala pa sa
  kit na ito. Puwede itong idagdag sa susunod.

## Setup (mga 20 minuto, isang beses lang)

1. **Kunin ang token.** Sundan ang [docs/SETUP.md](docs/SETUP.md).
2. **Gawin ang `.env`.** Kopyahin ang `.env.example`, pangalanang `.env`, at ikaw mismo
   ang mag-paste ng token doon. **Huwag i-paste ang token sa chat kay Claude.**
3. **I-build at i-test:**
   ```
   npm install
   npm run build
   npm run doctor
   ```
   Dapat lumabas ang listahan ng Pages mo at ang salitang `OK`.
4. **Ikonekta si Claude:**
   - **Claude Code (VS Code o terminal):** buksan ang folder na ito. Babasahin ni Claude
     ang `.mcp.json` at magtatanong kung papayagan ang `facebook` server. Piliin ang yes.
   - **Claude Desktop:** idagdag ito sa `%APPDATA%\Claude\claude_desktop_config.json`,
     tapos i-restart ang Claude Desktop:
     ```json
     {
       "mcpServers": {
         "facebook": {
           "command": "node",
           "args": ["C:\\Users\\axery\\Desktop\\facebook-automation\\dist\\server.js"]
         }
       }
     }
     ```
5. **Tingnan kung konektado.** Sabihin kay Claude: *"i-check mo ang facebook setup"*
   (`fb_setup_status`). Kahit wala pang `.env`, kokonekta ang server at sasabihin kung ano ang kulang.
6. **Subukan muna ang read.** Sabihin kay Claude: *"ilista mo ang mga Page ko at ang huling 5 post"*.
7. **Kapag OK na,** gawing `FB_WRITE_ENABLED=true` sa `.env` at i-restart si Claude para
   makapag-post, sumagot at mag-message na siya.

## Safety na naka-built in

- **Naka-off ang write sa simula.** Hindi makakapag-post o makakapag-delete si Claude
  hangga't hindi mo binubuksan ang `FB_WRITE_ENABLED`.
- **Kailangan ng `confirm: true` sa delete.** Magtatanong din ang Claude Code bago
  gumamit ng bawat tool.
- **Walang dobleng post.** Kapag nag-retry si Claude, hindi na uulitin ang post, reply o
  message na may parehong `idempotency_key`.
- **May rate limit:** 10 write at 120 read kada minuto (default). Puwedeng palitan sa `.env`.
- **Hindi lumalabas ang token** sa logs at error messages, at may secret scan bago ang bawat commit.
- **Sa `media/` lang puwedeng kumuha ng upload.** Hindi kayang i-upload ni Claude ang ibang
  file sa computer mo.
- **Ang leads ay personal data** (Data Privacy Act). Nasa `exports/` lang ito at hindi
  kailanman naco-commit.

## Para sa developer

```
npm run check    # typecheck + tests + secret scan
npm run build    # kailangan pagkatapos baguhin ang src/
```
