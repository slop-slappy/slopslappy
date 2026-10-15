# Chrome Web Store listing — paste-ready

Developer console: https://chrome.google.com/webstore/devconsole
Sign in with slappyjoke@gmail.com. One-time $5 registration.
Upload the store zip (manifest.json at the root of the zip, no README/notes/docs).

---

## Store listing tab

**Name**
SlopSlappy

**Summary** (132 chars max — this one is 109)
Your AI said something stupid. Click the slipper and a voice says what you're thinking. 12 languages. All offline.

**Description**

A small slipper appears next to every AI answer on ChatGPT, Claude, Gemini and Manus. Click it, and a voice says what you were already thinking — out loud, in your language.

WHAT'S INSIDE
• 12 languages: English, Hindi, Hinglish, Punjabi, Spanish, French, German, Portuguese, Italian, Japanese, Korean, Russian
• 2,522 bundled clips — Man and Woman voices, three intensity tiers, full rants, dry sighs, radio and monster effects
• 12 original personas — Furious Desi Uncle, No-Nonsense Desi Aunty, Hindi Film Villain, Telenovela, Caesar, Shakespeare and more
• Hold to scream — hold the slipper and scream into your mic; it reacts to how loud you are. Nothing is recorded.
• My Voice — record your own rant and use that instead. It never leaves your browser.

HOW IT WORKS
Click the slipper to start or stop. Click ⋯ for settings. Escape closes settings and stops playback. If a site changes its layout and the slipper lands in the corner, use "Place beside answer…" in settings and click any icon under the AI's reply.

Default is Punjabi, Man, Clear, 60 seconds. Nothing plays until you click.

PRIVACY
SlopSlappy never phones home. It does not read, store or send your chats. All audio is bundled — no downloads, no streaming, no remote code, no analytics, no account. Hold-to-scream measures mic volume in the moment and discards it. My Voice saves only after you press Save, to your browser's local storage, and is deleted when you uninstall.

CONTENT NOTE
This extension contains strong profanity in every language. All insults are aimed at the AI, never at people or groups. All voices are AI-performed; personas are original fictional characters and parodies, not celebrity voices.

Open source: https://github.com/slop-slappy/slopslappy
Website: https://slopslappy.com

**Category**
Fun

**Language**
English

**Store icon**
icons/icon-128.png (128×128)

**Screenshots** (1280×800 or 640×400, PNG/JPEG, up to 5)
Take these from the real extension, not the promo videos — reviewers check.
1. ChatGPT answer with the slipper beside the action row
2. Settings panel open, showing languages
3. Personas list
4. My Voice recorder
5. Claude or Gemini with the slipper, to show multi-site

**Promo tile** (440×280, optional but helps)
Mascot on yellow, "SlopSlappy" — crop assets/social-preview.png

**Official URL / Homepage**
https://slopslappy.com

**Support URL**
https://github.com/slop-slappy/slopslappy/issues

**Mature content**
YES — tick it. Reason: strong language / profanity.

---

## Privacy tab

**Single purpose description**
Plays bundled audio reactions (voice clips) when the user clicks a button that the extension places next to AI chat answers on chatgpt.com, claude.ai, gemini.google.com and manus.im.

**Permission justifications**

activeTab:
Needed to inject the slipper button and its stylesheet into the AI chat tab the user is currently viewing, only after the user clicks the extension icon. No other tabs are touched.

scripting:
Needed to run the content script that draws the slipper beside the AI answer and plays bundled audio. The script only runs on the four supported chat sites, only after the user activates the extension, and loads no remote code.

Host permissions:
None requested. Site access is granted per-tab via activeTab when the user clicks the extension.

**Are you using remote code?**
No. All JavaScript and audio are packaged in the extension.

**Data usage**
Tick NONE of the data types. SlopSlappy collects no personal data, no web history, no user activity, no website content and no authentication info.

Certify:
☑ I do not sell or transfer user data to third parties
☑ I do not use or transfer user data for purposes unrelated to the item's single purpose
☑ I do not use or transfer user data to determine creditworthiness or for lending

**Privacy policy URL**
https://slopslappy.com/privacy

---

## Distribution tab

Visibility: Public
Regions: all

---

## After submission

Review usually takes a few days; the mature flag sometimes adds a few more. If they bounce it, the most likely reasons are (1) a screenshot that isn't the real UI, (2) the permission justification wording — resubmit with the text above, or (3) a request to clarify microphone use: answer that getUserMedia is requested only on user gesture (holding the slipper or pressing Start in My Voice) and that no audio is transmitted.

Once approved, replace "coming soon" in README.md and docs/index.html with the store URL.
