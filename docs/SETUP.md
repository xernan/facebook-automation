# Paano kunin ang Facebook token

> **Huwag kailanman i-paste o i-screenshot ang token o App Secret sa chat.** Diretso mo
> itong ilagay sa `.env`.

Paalala: palaging binabago ng Meta ang itsura ng dashboard nila. Kung iba na ang pangalan
ng button, hanapin ang pinakamalapit na katumbas.

## 1. Gumawa ng Meta App

1. Pumunta sa <https://developers.facebook.com/apps> at mag-login gamit ang account na
   **admin ng Page**.
2. I-click ang **Create App**, piliin ang use case na **"Manage everything on your Page"**
   (o *Other* → *Business*), tapos ikonekta sa Business Portfolio mo.
3. Sa **App settings → Basic**, kopyahin ang **App Secret** papunta sa `.env` bilang
   `FB_APP_SECRET`.

## 2. Mga permission na kailangan

Idagdag ang mga ito sa app (Use cases → Customize, o App Review → Permissions):

| Permission | Para saan |
|---|---|
| `pages_show_list` | Ilista ang Pages mo |
| `pages_read_engagement` | Basahin ang posts, comments at followers |
| `pages_manage_posts` | Mag-post, mag-edit, mag-schedule at mag-delete |
| `pages_manage_engagement` | Sumagot, mag-hide at mag-delete ng comments |
| `pages_read_user_content` | Basahin ang comments at reviews ng mga tao |
| `pages_manage_metadata` | I-update ang Page info |
| `pages_messaging` | Messenger: basahin at sumagot |
| `read_insights` | Insights |
| `leads_retrieval` + `pages_manage_ads` | Kunin ang Lead Ads leads |

Kapag ikaw lang ang gagamit, at Admin o Developer ka ng app, gagana ang mga ito nang
hindi na kailangan ng App Review.

## 3. Kunin ang token (pumili ng isa)

### A. System User token (inirerekomenda: hindi nag-e-expire)

1. Pumunta sa **business.facebook.com → Settings → Users → System users → Add**
   at pumili ng role na **Admin**.
2. **Assign assets**: piliin ang Page mo at bigyan ng full control.
3. I-click ang **Generate new token**, piliin ang app mo, i-check ang lahat ng permission
   sa itaas, at piliin ang **Never** sa expiry.
4. I-paste ito sa `.env` bilang `FB_USER_ACCESS_TOKEN`.

### B. Long-lived user token (mabilis, pero 60 araw lang)

1. Sa **Graph API Explorer** (<https://developers.facebook.com/tools/explorer>), piliin ang
   app mo, idagdag ang mga permission, at i-click ang **Generate Access Token**.
2. Sa **Access Token Debugger** (<https://developers.facebook.com/tools/debug/accesstoken>),
   i-click ang **Extend Access Token**.
3. I-paste ang mahabang token sa `.env` bilang `FB_USER_ACCESS_TOKEN`. Ulitin ito bago
   ito mag-expire.

## 4. I-check

```
npm run build
npm run doctor
```

Dapat lumabas ang Pages mo. Kung may error:

| Error | Ayos |
|---|---|
| `Access token is invalid or expired` | Gumawa ng bagong token (step 3) |
| `Missing permission` | Kulang ang permission sa step 2. Gumawa ulit ng token pagkatapos idagdag. |
| `manages no Pages` | Hindi naka-assign ang Page sa System User, o kulang ang `pages_show_list` |
| `No internet connection` | I-check ang internet |

## 5. Bago mag-launch o mag-share

- Test Page muna ang gamitin habang sinusubukan mo ang mga write tool.
- Kapag may nakakita o nakakuha ng token, i-revoke ito agad sa Business Settings at gumawa ng bago.
