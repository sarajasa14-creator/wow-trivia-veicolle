# WoW Trivia

Epävirallinen fanihanke. Ei sidoksissa Blizzard Entertainmentiin.

Staattinen tietovisa (ei build-vaihetta). Moninpeli kulkee Supabase Realtimen kautta, Solo toimii ilman sitä.

## Helppo aloitus: GitHub + Netlify

### 1. Laita tiedostot GitHubiin
1. Mene osoitteeseen github.com ja paina **New repository**. Nimeksi `wow-trivia`, jätä **Public** ja paina **Create repository**.
2. Paina sivulla linkkiä **uploading an existing file**.
3. Vedä sisään nämä tiedostot (pura zip ensin): `index.html`, `style.css`, `app.js`, `questions.js`, `config.js`, `netlify.toml`, `README.md`.
4. Paina **Commit changes**.

### 2. Julkaise Netlifyssä
1. Netlify → **Add new project** → **Import an existing project** → **GitHub**.
2. Valitse repo `wow-trivia`.
3. **Build command**: jätä tyhjäksi. **Publish directory**: `.` (tai tyhjä). Asetukset tulevat `netlify.toml`:sta.
4. Paina **Deploy**. Hetken päästä saat osoitteen `https://jokinimi.netlify.app`.

### 3. Lisää Supabase-avaimet (vain moninpeliin)
1. Supabase → Project Settings → API. Kopioi **Project URL** ja **anon public** -avain.
2. GitHubissa avaa `config.js` → kynäkuvake (Edit) → liitä arvot paikoilleen → **Commit changes**.
3. Netlify julkaisee muutoksen automaattisesti noin minuutissa.
4. Älä koskaan käytä `service_role`-avainta.

### 4. Kokeile
- **Solo**: paina "Solo". Toimii heti.
- **Moninpeli**: kahdella puhelimella, toinen luo pelin ja kopioi kutsulinkin, toinen avaa linkin.

## Jos jokin ei toimi
- Sivulla lukee "Moninpeliä ei ole vielä otettu käyttöön": `config.js` on vielä oletusarvoilla.
- Muutos ei näy: odota minuutti ja päivitä sivu (Ctrl+F5).
- Moninpeli ei yhdistä: tarkista Supabasen Realtime-asetuksista, että julkiset kanavat ovat sallittuja.
