/* global chrome */
(() => {
  "use strict";

  const APP_KEY = "__ragequit_extension_controller__";
  const DESTROY_EVENT = "__ragequit_extension_destroy__";
  const ROOT_ATTRIBUTE = "data-ragequit-extension-root";
  const OWNED_ATTRIBUTE = "data-ragequit-owned";
  const MAX_RAGE_MS = 5_000;

  function hasCatalogShape(candidate) {
    return Boolean(
      candidate &&
        Array.isArray(candidate.languages) &&
        candidate.languages.every(
          item =>
            item &&
            ["id", "label", "native"].every(
              key => typeof item[key] === "string"
            )
        ) &&
        Array.isArray(candidate.phrases) &&
        candidate.phrases.every(
          item =>
            item &&
            ["id", "language", "label", "text", "audio", "intensity"].every(
              key => typeof item[key] === "string"
            )
        ) &&
        candidate.sighs &&
        typeof candidate.sighs === "object"
    );
  }

  function hasPersonaCatalogShape(candidate) {
    return Boolean(
      candidate &&
        typeof candidate.disclaimer === "string" &&
        Array.isArray(candidate.packs) &&
        candidate.packs.every(
          pack =>
            pack &&
            typeof pack.id === "string" &&
            typeof pack.label === "string" &&
            typeof pack.languageLabel === "string" &&
            typeof pack.language === "string" &&
            Array.isArray(pack.clips) &&
            pack.clips.length === 2 &&
            pack.clips.every(
              clip =>
                clip &&
                typeof clip.text === "string" &&
                typeof clip.audio === "string" &&
                /^personas\/[a-z0-9-]+-[12]\.mp3$/.test(clip.audio)
            )
        )
    );
  }

  // background.js injects this bundled catalog into this extension's isolated world
  // before this file runs. There is intentionally no page-context or network fetch.
  const packs = hasCatalogShape(window.__ragequit_packs__)
    ? window.__ragequit_packs__
    : { languages: [], phrases: [], sighs: {} };
  const personas = hasPersonaCatalogShape(window.__ragequit_personas__)
    ? window.__ragequit_personas__
    : { disclaimer: "", packs: [] };
  // "mix" = every bundled clip in the chosen language, all voices, shuffled.
  const defaultPersonaId = "generic";
  const defaultLanguageId = packs.languages.some(
    language => language.id === "pa"
  )
    ? "pa"
    : packs.languages[0]?.id || "";
  const defaultPhraseId =
    packs.phrases.find(
      phrase =>
        phrase.language === defaultLanguageId &&
        phrase.id === `${defaultLanguageId}-meltdown`
    )?.id ||
    packs.phrases.find(phrase => phrase.language === defaultLanguageId)?.id ||
    "";

  // A second toolbar click can race a prior injection. The existing isolated-world
  // controller owns its lifecycle, so a duplicate script intentionally does nothing.
  if (window[APP_KEY]) return;

  const state = {
    destroyed: false,
    root: null,
    observer: null,
    scanFrame: null,
    rageTimer: null,
    burstTimer: null,
    burstTickTimer: null,
    burstGeneration: 0,
    burstEndsAt: 0,
    burstActive: false,
    burstCycle: [],
    burstIndex: 0,
    burstDuration: 60,
    burstSpeed: 1,
    burstScope: "language",
    burstVoiceActor: null,
    burstVoiceStyle: null,
    burstPersona: null,
    burstMix: false,
    burstItems: [],
    burstLastAudio: null,
    control: null,
    manualRow: null,
    pickingPlacement: false,
    micGeneration: 0,
    stream: null,
    context: null,
    source: null,
    frame: null,
    holding: null,
    active: false,
    mode: null,
    status: "READY — LOCAL ONLY",
    audio: null,
    personalGeneration: 0,
    personalTimer: null,
    personalObjectUrl: null,
    personalFavorites: [],
    personalFavoriteId: "",
    personalLoading: false,
    personalUseAsRage: false,
    volume: 0.45,
    soundOn: true,
    explicitOn: true,
    packs,
    personas,
    personaId: defaultPersonaId,
    languageId: defaultLanguageId,
    phraseId: defaultPhraseId,
    voiceActor: "man",
    voiceStyle: "dry",
    reactionIntensity: "all",
    presetKind: null,
    fallback: null,
    controls: new Set(),
    responseControls: new Map(),
  };

  const selectorsBySite = {
    "chatgpt.com": [
      "[data-assistant-markdown]",
      '[data-message-role="assistant"]',
      'article[data-turn="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-testid="conversation-turn"][data-turn="assistant"]',
      '[data-testid="conversation-turn"][data-message-author-role="assistant"]',
    ],
    "chat.openai.com": [
      "[data-assistant-markdown]",
      '[data-message-role="assistant"]',
      'article[data-turn="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-testid="conversation-turn"][data-turn="assistant"]',
      '[data-testid="conversation-turn"][data-message-author-role="assistant"]',
    ],
    "claude.ai": [
      "[data-is-streaming]",
      '[data-testid="conversation-turn"][data-is-assistant="true"]',
      '[data-testid="conversation-turn"][data-message-role="assistant"]',
      '[data-message-role="assistant"]',
      '[data-testid="assistant-message"]',
      '[data-is-assistant="true"]',
    ],
    "gemini.google.com": [
      "model-response",
      '[data-message-author-role="assistant"]',
      '[data-author-role="model"]',
      'message-content[role="assistant"]',
      '[data-testid="model-response"]',
    ],
    "manus.im": [
      '[data-message-role="assistant"]',
      '[data-role="assistant"]',
      '[data-author="assistant"]',
      '[data-testid="assistant-message"]',
    ],
  };

  function siteSelectors() {
    const host = window.location.hostname;
    const root = Object.keys(selectorsBySite).find(
      candidate => host === candidate || host.endsWith(`.${candidate}`)
    );
    return root ? selectorsBySite[root] : [];
  }

  function localUrl(path) {
    return chrome.runtime.getURL(path);
  }

  function setStatus(message) {
    state.status = message;
    render();
  }

  function phrasesForLanguage(languageId = state.languageId) {
    return state.packs.phrases.filter(phrase => phrase.language === languageId);
  }

  function selectedPhrase() {
    const phrases = phrasesForLanguage();
    const selected = phrases.find(phrase => phrase.id === state.phraseId);
    if (selected) return selected;
    state.phraseId = phrases[0]?.id || "";
    return phrases[0] || null;
  }

  function selectedSigh() {
    const localized = state.packs.sighs?.[state.languageId];
    const english = state.packs.sighs?.en;
    const sigh = localized || english;
    if (!sigh?.audio || !sigh?.text) return null;
    return { ...sigh, englishFallback: !localized && Boolean(english) };
  }

  function selectedPersona() {
    if (state.personaId === "generic") return null;
    return (
      state.personas.packs.find(pack => pack.id === state.personaId) || null
    );
  }

  function useGenericSettings() {
    const persona = selectedPersona();
    if (persona) {
      state.languageId = persona.language;
      state.phraseId = phrasesForLanguage()[0]?.id || "";
      state.personaId = "generic";
    } else if (state.personaId === "mix") {
      state.personaId = "generic";
    }
    state.personalUseAsRage = false;
    stopAll("SETTING CHANGED — GENERIC VOICE — STOPPED");
  }

  function replacePersonaOptions(select) {
    select.replaceChildren();
    const mixOption = document.createElement("option");
    mixOption.value = "mix";
    mixOption.textContent = "Everyone · mixed voices";
    select.append(mixOption);
    for (const actor of ["man", "woman"]) {
      const option = document.createElement("option");
      option.value = actor;
      option.textContent =
        actor === "man" ? "Man · all languages" : "Woman · all languages";
      select.append(option);
    }
    const grouped = new Map();
    for (const pack of state.personas.packs) {
      const category = pack.category || "Playable personas";
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(pack);
    }
    for (const [category, packs] of grouped) {
      const group = document.createElement("optgroup");
      group.label = category;
      for (const pack of packs) {
        const option = document.createElement("option");
        option.value = pack.id;
        option.textContent = pack.label;
        group.append(option);
      }
      select.append(group);
    }
  }

  function shuffledItems(items, previousUrl) {
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    // Never play the same clip twice in a row across a reshuffle.
    if (previousUrl && shuffled.length > 1 && shuffled[0].url === previousUrl) {
      const replacement = shuffled.findIndex(item => item.url !== previousUrl);
      if (replacement > 0) {
        [shuffled[0], shuffled[replacement]] = [
          shuffled[replacement],
          shuffled[0],
        ];
      }
    }
    return shuffled;
  }

  function voiceActorLabel(actor = state.voiceActor) {
    return (
      {
        man: "Man · clear shout",
        woman: "Woman · clear shout",
      }[actor] || "Man · clear shout"
    );
  }

  function voiceStyleLabel(style = state.voiceStyle) {
    return (
      {
        radio: "Radio distortion",
        dry: "Clear (default)",
        monster: "Monster pitch",
      }[style] || "Clear (default)"
    );
  }

  function reactionTierLabel() {
    return state.reactionIntensity === "meltdown"
      ? "LONG RANTS"
      : "SHORT CURSES";
  }

  function audioUrl(
    audioFile,
    kind,
    actor = state.voiceActor,
    style = state.voiceStyle
  ) {
    // Calm sighs stay on their original recordings; shout voices use the
    // selected actor and optional local effect. No remote audio is requested.
    if (kind === "sigh")
      return `${localUrl(`audio/${audioFile}`)}?v=native-banks-2`;
    const effectDirectory = style === "dry" ? "" : `${style}/`;
    return `${localUrl(
      `audio/${actor}/${effectDirectory}${audioFile}`
    )}?v=native-banks-2`;
  }

  function replaceOptions(select, entries, getValue, getLabel) {
    select.replaceChildren();
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = getValue(entry);
      option.textContent = getLabel(entry);
      select.append(option);
    }
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function personalLabel(recording) {
    const seconds = Math.max(0, Math.round(Number(recording.duration) || 0));
    return `${recording.name} · ${Math.floor(seconds / 60)}:${String(
      seconds % 60
    ).padStart(2, "0")}`;
  }

  function renderPersonalControl(control) {
    const favorites = state.personalFavorites;
    const entries = favorites.length
      ? favorites
      : [
          {
            id: "",
            name: state.personalLoading
              ? "LOADING FAVORITES…"
              : "NO SAVED FAVORITES",
          },
        ];
    replaceOptions(
      control.personalSelect,
      entries,
      recording => recording.id,
      personalLabel
    );
    control.personalSelect.value = state.personalFavoriteId;
    control.personalSelect.disabled =
      state.personalLoading || !favorites.length;
    control.personalRefresh.disabled = state.personalLoading;
    control.personalPlay.disabled =
      state.personalLoading ||
      !favorites.some(recording => recording.id === state.personalFavoriteId);
    control.personalUse.disabled = control.personalPlay.disabled;
    control.personalUse.setAttribute(
      "aria-pressed",
      String(state.personalUseAsRage)
    );
    control.personalUse.textContent = state.personalUseAsRage
      ? "RAGE: MY VOICE"
      : "USE AS RAGE";
  }

  async function refreshPersonalFavorites() {
    state.personalLoading = true;
    render();
    try {
      const response = await runtimeMessage({ type: "list-personal" });
      if (!response?.ok || !Array.isArray(response.recordings)) {
        throw new Error(response?.error || "Could not read local favorites");
      }
      state.personalFavorites = response.recordings.filter(
        recording =>
          recording &&
          typeof recording.id === "string" &&
          typeof recording.name === "string" &&
          recording.favorite === true
      );
      if (
        !state.personalFavorites.some(
          recording => recording.id === state.personalFavoriteId
        )
      ) {
        state.personalFavoriteId = state.personalFavorites[0]?.id || "";
        state.personalUseAsRage = false;
      }
      state.personalLoading = false;
      render();
    } catch (error) {
      state.personalLoading = false;
      state.personalFavorites = [];
      state.personalFavoriteId = "";
      setStatus(
        `MY VOICE FAVORITES UNAVAILABLE — ${error.message || "TRY STUDIO"}`
      );
    }
  }

  function renderCatalogControl(control) {
    const catalogAvailable =
      state.packs.languages.length > 0 && state.packs.phrases.length > 0;
    const persona = selectedPersona();
    const personaActive = Boolean(persona);
    const phrase = selectedPhrase();
    const sigh = selectedSigh();

    replacePersonaOptions(control.persona);
    control.persona.value =
      state.personaId === "generic" ? state.voiceActor : state.personaId;
    control.persona.disabled = !state.personas.packs.length;
    control.personaNote.textContent = persona
      ? `Recorded in ${persona.languageLabel}. Choose a language, actor, effect, phrase mix, or tier to use the compatible multilingual Man / Woman pack. ${persona.description} AI-performed fictional interpretation only — not an authentic or celebrity voice. ${state.personas.disclaimer}`
      : state.personaId === "mix"
        ? "Everyone plays every bundled clip in the chosen language, all voices, shuffled. Picking an actor, effect, phrase, scope, or tier switches to the generic Man / Woman pack."
        : "Generic Man / Woman uses the generic language, actor, effect, phrase, and scope controls.";

    replaceOptions(
      control.language,
      state.packs.languages,
      language => language.id,
      language => `${language.label} — ${language.native}`
    );
    control.language.value = persona?.language || state.languageId;
    control.language.disabled = !catalogAvailable;

    if (!state.explicitOn) {
      replaceOptions(
        control.phrase,
        [{ id: "disabled", label: "CURSES DISABLED" }],
        entry => entry.id,
        entry => entry.label
      );
      control.phrase.disabled = true;
      control.preview.textContent =
        "CURSES DISABLED — TURN LET IT SWEAR ON TO PREVIEW";
      control.intensity.textContent = "INTENSITY: —";
    } else if (!phrase) {
      replaceOptions(
        control.phrase,
        [{ id: "unavailable", label: "CATALOG UNAVAILABLE" }],
        entry => entry.id,
        entry => entry.label
      );
      control.phrase.disabled = true;
      control.preview.textContent =
        "CATALOG UNAVAILABLE — REOPEN FROM THE TOOLBAR";
      control.intensity.textContent = "INTENSITY: —";
    } else {
      replaceOptions(
        control.phrase,
        phrasesForLanguage(),
        entry => entry.id,
        entry => entry.label
      );
      control.phrase.value = phrase.id;
      control.phrase.disabled = false;
      control.preview.textContent = phrase.text;
      control.intensity.textContent = `INTENSITY (EDITORIAL): ${phrase.intensity}`;
    }

    control.voiceActor.value = state.voiceActor;
    control.voiceStyle.value = state.voiceStyle;
    control.reactionTier.value = state.reactionIntensity;
    control.reactionTier.disabled = false;
    control.curse.disabled = !state.explicitOn || !phrase;
    control.random.disabled = !state.explicitOn || !phrase;
    control.sigh.disabled = !sigh;
    control.sigh.textContent = sigh?.englishFallback
      ? "CALM SIGH (EN)"
      : "CALM SIGH";
    control.sighNote.textContent = sigh
      ? sigh.englishFallback
        ? "CALM SIGH: ENGLISH FALLBACK · ORIGINAL VOICE"
        : "CALM SIGH: LANGUAGE MATCH · ORIGINAL VOICE"
      : "CALM SIGH UNAVAILABLE";

    control.voiceActor.disabled = false;
    control.voiceStyle.disabled = false;
    for (const element of [
      control.phrase.closest("label"),
      control.preview,
      control.intensity,
      control.curse,
      control.random,
      control.voiceActor.closest(".rq-voice-options"),
      control.sigh,
      control.sighNote,
    ]) {
      if (element) element.hidden = false;
    }
    for (const select of [
      control.voiceActor,
      control.voiceStyle,
      control.phrase,
    ])
      renderQuickChoice(select);
  }

  function burstPhrases() {
    const available =
      state.burstScope === "all" ? state.packs.phrases : phrasesForLanguage();
    // Rapid-fire plays the short lines; the long rants have their own tier.
    const rants = available.filter(phrase => phrase.intensity === "Meltdown");
    const short = available.filter(phrase => phrase.intensity !== "Meltdown");
    const tiered =
      state.reactionIntensity === "meltdown"
        ? rants
        : short.length
          ? short
          : available;
    const selectedIndex = tiered.findIndex(
      phrase => phrase.id === state.phraseId
    );
    return selectedIndex > 0
      ? [...tiered.slice(selectedIndex), ...tiered.slice(0, selectedIndex)]
      : [...tiered];
  }

  function personaClipUrl(clip) {
    return `${localUrl(`audio/${clip.audio}`)}?v=personas2`;
  }

  function burstItems() {
    const persona = selectedPersona();
    if (persona) {
      return persona.clips.map(clip => ({
        text: clip.text,
        url: personaClipUrl(clip),
      }));
    }
    if (state.personaId === "mix") {
      const items = [];
      for (const pack of state.personas.packs) {
        if (pack.language !== state.languageId) continue;
        for (const clip of pack.clips) {
          items.push({ text: clip.text, url: personaClipUrl(clip) });
        }
      }
      const languagePhrases = phrasesForLanguage();
      const shortPhrases = languagePhrases.filter(
        phrase => phrase.intensity !== "Meltdown"
      );
      for (const phrase of shortPhrases.length
        ? shortPhrases
        : languagePhrases) {
        items.push({
          text: phrase.text,
          url: audioUrl(phrase.audio, "burst", "man", "dry"),
        });
        if (state.packs.separateActors?.includes(phrase.audio)) {
          items.push({
            text: phrase.text,
            url: audioUrl(phrase.audio, "burst", "woman", "dry"),
          });
        }
      }
      return items;
    }
    return burstPhrases().map(phrase => ({
      text: phrase.text,
      url: audioUrl(phrase.audio, "burst"),
    }));
  }

  function formatBurstTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${Math.floor(totalSeconds / 60)}:${String(
      totalSeconds % 60
    ).padStart(2, "0")}`;
  }

  function burstScopeLabel() {
    return state.burstScope === "all" ? "ALL LANGUAGES" : "THIS LANGUAGE";
  }

  function renderQuickChoice(select) {
    select.hidden = true;
    let choices = select.parentElement.querySelector(".rq-quick-choice");
    if (!choices) {
      choices = document.createElement("div");
      choices.className = "rq-quick-choice";
      select.parentElement.append(choices);
    }
    choices.replaceChildren();
    for (const option of select.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rq-button";
      button.textContent = option.textContent;
      button.setAttribute(
        "aria-pressed",
        String(select.value === option.value)
      );
      button.disabled = select.disabled;
      button.addEventListener("click", () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      choices.append(button);
    }
  }

  function renderBurstControl(control) {
    const hasPhrases = burstItems().length > 0;
    control.burstDuration.value = String(state.burstDuration);
    control.burstSpeed.value = String(state.burstSpeed);
    control.burstScope.value = state.burstScope;
    control.burstDuration.disabled = false;
    control.burstSpeed.disabled = false;
    control.burstScope.disabled = false;
    control.burstScope.closest("label").hidden = false;
    control.reactionTier.closest("label").hidden = false;
    for (const select of [
      control.burstDuration,
      control.burstSpeed,
      control.burstScope,
      control.reactionTier,
    ])
      renderQuickChoice(select);
    control.barrage.disabled =
      !state.explicitOn || !state.soundOn || !hasPhrases || state.burstActive;
  }

  function render() {
    for (const control of state.controls) {
      if (!control.host.isConnected) continue;
      const playing = Boolean(state.active || state.audio || state.holding);
      control.panel.classList.toggle("rq-active", playing);
      control.launcher.classList.toggle("rq-playing", playing);
      control.launcher.setAttribute("aria-pressed", String(playing));
      control.launcher.setAttribute(
        "aria-label",
        playing
          ? "Stop SlopSlappy reaction"
          : "SlopSlappy: react to this answer"
      );
      control.launcher.title = playing
        ? "Stop SlopSlappy reaction"
        : `SlopSlappy · ${state.status}`;
      const fallback = control.host.dataset.ragequitMode === "fallback";
      const placement = control.panel.querySelector(
        '[data-action="placement"]'
      );
      placement.hidden = !fallback;
      control.panel.querySelector('[data-action="pick-placement"]').hidden =
        !fallback;
      placement.textContent = fallback
        ? "Floating mode — answer actions not detected on this layout."
        : "";
      control.status.textContent = state.status;
      control.rage.textContent =
        state.active || state.audio
          ? "STOP"
          : state.personalUseAsRage
            ? "RAGE / MY VOICE"
            : `RAGE / ${state.burstDuration} SEC`;
      control.soundToggle.setAttribute("aria-pressed", String(state.soundOn));
      control.soundToggle.textContent = state.soundOn
        ? "SOUND: ON"
        : "SOUND: OFF";
      control.explicitToggle.setAttribute(
        "aria-pressed",
        String(state.explicitOn)
      );
      control.explicitToggle.textContent = state.explicitOn
        ? "LET IT SWEAR: ON"
        : "LET IT SWEAR: OFF";
      renderCatalogControl(control);
      renderBurstControl(control);
      renderPersonalControl(control);
      control.silent.setAttribute(
        "aria-pressed",
        String(state.mode === "silent")
      );
      control.volume.value = String(Math.round(state.volume * 100));
      control.volumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
  }

  function setLevel(level) {
    const safeLevel = Math.max(0, Math.min(1, level));
    for (const control of state.controls) {
      if (control.host.isConnected) {
        control.panel.style.setProperty("--rq-level", String(safeLevel));
      }
    }
  }

  function clearRageTimer() {
    if (state.rageTimer !== null) {
      window.clearTimeout(state.rageTimer);
      state.rageTimer = null;
    }
  }

  function clearBurst() {
    state.burstGeneration += 1;
    if (state.burstTimer !== null) {
      window.clearTimeout(state.burstTimer);
      state.burstTimer = null;
    }
    if (state.burstTickTimer !== null) {
      window.clearTimeout(state.burstTickTimer);
      state.burstTickTimer = null;
    }
    state.burstActive = false;
    state.burstEndsAt = 0;
    state.burstCycle = [];
    state.burstIndex = 0;
    state.burstVoiceActor = null;
    state.burstVoiceStyle = null;
    state.burstPersona = null;
    state.burstMix = false;
    state.burstItems = [];
    state.burstLastAudio = null;
  }

  function isCurrentBurst(generation) {
    return (
      !state.destroyed &&
      state.burstActive &&
      generation === state.burstGeneration
    );
  }

  function burstStatus() {
    if (state.burstPersona) {
      return `BARRAGE: ${formatBurstTime(
        state.burstEndsAt - Date.now()
      )} LEFT — ${state.burstSpeed}× — ${state.burstPersona.languageLabel} — PERSONA CLIPS`;
    }
    if (state.burstMix) {
      return `BARRAGE: ${formatBurstTime(
        state.burstEndsAt - Date.now()
      )} LEFT — ${state.burstSpeed}× — MIXED VOICES — ${state.burstItems.length} CLIPS`;
    }
    return `BARRAGE: ${formatBurstTime(
      state.burstEndsAt - Date.now()
    )} LEFT — ${state.burstSpeed}× — ${burstScopeLabel()} — ${reactionTierLabel()}`;
  }

  function updateBurstCountdown(generation) {
    if (!isCurrentBurst(generation)) return;
    if (Date.now() >= state.burstEndsAt) {
      stopAll("BARRAGE COMPLETE — 0:00");
      return;
    }
    setStatus(burstStatus());
    state.burstTickTimer = window.setTimeout(
      () => updateBurstCountdown(generation),
      1_000
    );
  }

  function stopAudio() {
    if (state.audio) {
      const audio = state.audio;
      state.audio = null;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // A failed or not-yet-seekable packaged resource still stops via pause().
      }
      audio.removeAttribute("src");
      audio.load();
    }
    if (state.personalObjectUrl) {
      URL.revokeObjectURL(state.personalObjectUrl);
      state.personalObjectUrl = null;
    }
  }

  function clearPersonalTimer() {
    if (state.personalTimer !== null) {
      window.clearTimeout(state.personalTimer);
      state.personalTimer = null;
    }
  }

  /**
   * Mirrors the application microphone lifecycle: only an analyser is connected.
   * There is deliberately no recorder, transcription, persistence, or network use.
   */
  function stopMicrophone() {
    state.micGeneration += 1;
    if (state.frame !== null) {
      window.cancelAnimationFrame(state.frame);
      state.frame = null;
    }
    state.source?.disconnect();
    state.source = null;
    state.stream?.getTracks().forEach(track => track.stop());
    state.stream = null;
    if (state.context) void state.context.close().catch(() => undefined);
    state.context = null;
    state.holding = null;
    setLevel(0);
  }

  function beginRage(message) {
    clearRageTimer();
    state.active = true;
    setLevel(0.18);
    setStatus(message);
    state.rageTimer = window.setTimeout(() => {
      stopAll("5 SECOND LIMIT — STOPPED");
    }, MAX_RAGE_MS);
  }

  function stopAll(message = "STOPPED") {
    state.personalGeneration += 1;
    clearPersonalTimer();
    clearRageTimer();
    clearBurst();
    stopMicrophone();
    stopAudio();
    state.active = false;
    state.mode = null;
    state.presetKind = null;
    setStatus(message);
  }

  function stale(generation) {
    return (
      state.destroyed || generation !== state.micGeneration || !state.holding
    );
  }

  async function startMicrophone(origin) {
    if (state.destroyed) return;

    stopAll("REQUESTING LOCAL MIC — RELEASE TO CANCEL");
    const generation = state.micGeneration;
    state.holding = origin;
    state.mode = "mic";
    beginRage("HOLDING MIC — AMPLITUDE STAYS ON THIS DEVICE");

    if (!navigator.mediaDevices?.getUserMedia) {
      stopAll("MIC UNAVAILABLE HERE — USE SILENT RAGE");
      return;
    }

    let stream;
    let context;
    let source;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });

      // Permission can resolve after a pointer/key release. Never activate it then.
      if (stale(generation)) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio analysis is unavailable");
      context = new AudioContextClass();
      // Expose resources before resume resolves so release stops them immediately.
      state.stream = stream;
      state.context = context;
      await context.resume();
      if (stale(generation)) {
        stream.getTracks().forEach(track => track.stop());
        void context.close().catch(() => undefined);
        return;
      }

      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source = context.createMediaStreamSource(stream);
      source.connect(analyser); // Never connected to speakers or a recorder.

      state.stream = stream;
      state.context = context;
      state.source = source;
      const data = new Uint8Array(analyser.fftSize);
      const sample = () => {
        if (stale(generation)) return;
        analyser.getByteTimeDomainData(data);
        let energy = 0;
        for (const value of data) energy += ((value - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(energy / data.length) * 5));
        state.frame = window.requestAnimationFrame(sample);
      };
      sample();
    } catch (error) {
      source?.disconnect();
      stream?.getTracks().forEach(track => track.stop());
      if (context) void context.close().catch(() => undefined);
      if (!stale(generation)) {
        stopAll("MIC BLOCKED OR DENIED — USE SILENT RAGE");
      }
    }
  }

  function releaseHold(origin) {
    if (!state.holding || state.holding.type !== origin.type) return;
    if (
      origin.type === "pointer" &&
      state.holding.pointerId !== origin.pointerId
    )
      return;
    stopAll("MIC OFF — RELEASED");
  }

  function startSilentRage() {
    stopAll("SILENT RAGE — 5 SECOND VISUAL ONLY");
    state.mode = "silent";
    beginRage("SILENT RAGE — 5 SECOND VISUAL ONLY");
  }

  function playBundledAudio({ kind, audioFile, label, status }) {
    stopAll(status);
    state.mode = "preset";
    state.presetKind = kind;
    beginRage(status);

    if (!state.soundOn) {
      setStatus("SOUND IS OFF — SILENT RAGE ACTIVE");
      return;
    }

    const audio = new Audio(audioUrl(audioFile, kind));
    audio.preload = "none";
    audio.volume = state.volume;
    state.audio = audio;
    audio.addEventListener(
      "ended",
      () => {
        if (state.audio === audio) {
          state.audio = null;
          render();
        }
      },
      { once: true }
    );
    audio.addEventListener(
      "error",
      () => {
        if (state.audio === audio) {
          state.audio = null;
          setStatus(`${label} AUDIO MISSING — USE SILENT RAGE`);
        }
      },
      { once: true }
    );
    audio.play().catch(() => {
      if (state.audio === audio) {
        state.audio = null;
        setStatus(`${label} AUDIO COULD NOT PLAY — USE SILENT RAGE`);
      }
    });
  }

  function playScream() {
    playBundledAudio({
      kind: "scream",
      audioFile: "scream.mp3",
      label: "SCREAM",
      status: "SCREAM PRESET — LOCAL AUDIO ONLY",
    });
  }

  function playSigh() {
    const sigh = selectedSigh();
    if (!sigh) {
      setStatus("SIGH UNAVAILABLE — CATALOG MISSING");
      return;
    }
    const fallback = sigh.englishFallback ? " — ENGLISH FALLBACK" : "";
    playBundledAudio({
      kind: "sigh",
      audioFile: sigh.audio,
      label: "CALM SIGH",
      status: `CALM SIGH${fallback}: “${sigh.text}” — ORIGINAL LOCAL AUDIO ONLY`,
    });
  }

  function playCurse() {
    if (!state.explicitOn) {
      setStatus("CURSES DISABLED — LET IT SWEAR IS OFF");
      return;
    }
    const phrase = selectedPhrase();
    if (!phrase?.audio) {
      setStatus("CURSE UNAVAILABLE — CATALOG MISSING");
      return;
    }
    playBundledAudio({
      kind: "curse",
      audioFile: phrase.audio,
      label: "CURSE",
      status: `CURSE: “${phrase.text}” — ${phrase.intensity} — LOCAL AUDIO ONLY`,
    });
  }

  function blobFromBase64(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType || "audio/webm" });
  }

  async function playPersonalFavorite() {
    const id = state.personalFavoriteId;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      setStatus("CHOOSE A SAVED MY VOICE FAVORITE FIRST");
      return;
    }

    stopAll("LOADING MY VOICE — LOCAL EXTENSION STORAGE ONLY");
    const generation = state.personalGeneration;
    state.active = true;
    state.mode = "personal";
    render();
    try {
      const response = await runtimeMessage({ type: "get-personal", id });
      if (!response?.ok || typeof response.recording?.base64 !== "string") {
        throw new Error(response?.error || "That favorite could not load");
      }
      if (state.destroyed || generation !== state.personalGeneration) return;
      const blob = blobFromBase64(
        response.recording.base64,
        response.recording.mimeType
      );
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      state.personalObjectUrl = objectUrl;
      state.audio = audio;
      audio.preload = "none";
      audio.volume = state.volume;
      const complete = message => {
        if (generation !== state.personalGeneration || state.audio !== audio)
          return;
        state.audio = null;
        clearPersonalTimer();
        if (state.personalObjectUrl) {
          URL.revokeObjectURL(state.personalObjectUrl);
          state.personalObjectUrl = null;
        }
        state.active = false;
        state.mode = null;
        setStatus(message);
      };
      audio.addEventListener(
        "ended",
        () => complete("MY VOICE COMPLETE — LOCAL ONLY"),
        {
          once: true,
        }
      );
      audio.addEventListener(
        "error",
        () => complete("MY VOICE COULD NOT PLAY — TRY STUDIO"),
        {
          once: true,
        }
      );
      state.personalTimer = window.setTimeout(() => {
        if (generation === state.personalGeneration && state.audio === audio) {
          stopAll("MY VOICE 30 SECOND LIMIT — STOPPED");
        }
      }, 30_000);
      await audio.play();
      if (generation === state.personalGeneration) {
        setStatus("MY VOICE PLAYING — 30 SECOND LIMIT · LOCAL ONLY");
      }
    } catch (error) {
      if (generation === state.personalGeneration) {
        stopAll(`MY VOICE UNAVAILABLE — ${error.message || "TRY STUDIO"}`);
      }
    }
  }

  async function openPersonalStudio() {
    try {
      const response = await runtimeMessage({ type: "open-studio" });
      if (!response?.ok)
        throw new Error(response?.error || "Could not open studio");
      setStatus("MY VOICE STUDIO OPENED — RECORD ONLY ON EXPLICIT START");
    } catch (error) {
      setStatus(
        `MY VOICE STUDIO UNAVAILABLE — ${error.message || "TRY EXTENSION OPTIONS"}`
      );
    }
  }

  function startPrimaryRage() {
    if (state.active || state.audio || state.holding) {
      stopAll("STOPPED BY YOU");
      return;
    }
    if (state.personalUseAsRage) {
      void playPersonalFavorite();
      return;
    }
    startBarrage();
  }

  function playBurstPhrase(generation) {
    if (!isCurrentBurst(generation)) return;
    if (Date.now() >= state.burstEndsAt) {
      stopAll("BARRAGE COMPLETE — 0:00");
      return;
    }

    if (state.burstIndex >= state.burstCycle.length) {
      state.burstCycle = shuffledItems(state.burstItems, state.burstLastAudio);
      state.burstIndex = 0;
    }
    const item = state.burstCycle[state.burstIndex];
    state.burstIndex += 1;
    if (!item?.url) {
      stopAll("BARRAGE CATALOG ERROR — STOPPED");
      return;
    }
    state.burstLastAudio = item.url;
    const audio = new Audio(item.url);
    audio.preload = "auto";
    audio.volume = state.volume;
    audio.playbackRate = state.burstSpeed;
    audio.preservesPitch = true;
    state.audio = audio;
    setStatus(`${burstStatus()} — “${item.text}”`);

    audio.addEventListener(
      "ended",
      () => {
        if (!isCurrentBurst(generation) || state.audio !== audio) return;
        state.audio = null;
        playBurstPhrase(generation);
      },
      { once: true }
    );
    audio.addEventListener(
      "error",
      () => {
        if (!isCurrentBurst(generation) || state.audio !== audio) return;
        stopAll("BARRAGE AUDIO MISSING — STOPPED");
      },
      { once: true }
    );
    audio.play().catch(() => {
      if (!isCurrentBurst(generation) || state.audio !== audio) return;
      stopAll("BARRAGE AUDIO COULD NOT PLAY — STOPPED");
    });
  }

  function startBarrage() {
    if (!state.explicitOn) {
      setStatus("CURSES DISABLED — LET IT SWEAR IS OFF");
      return;
    }
    if (!state.soundOn) {
      setStatus("TURN SOUND ON TO START A BARRAGE");
      return;
    }
    if (state.volume <= 0) {
      setStatus("RAISE VOLUME ABOVE ZERO TO START A BARRAGE");
      return;
    }
    // Voice, effect and clip list are frozen here, before anything is stopped.
    const persona = selectedPersona();
    const mix = !persona && state.personaId === "mix";
    const items = burstItems();
    if (!items.length) {
      setStatus("BARRAGE UNAVAILABLE — CATALOG MISSING");
      return;
    }

    stopAll("BARRAGE STARTING");
    state.burstGeneration += 1;
    const generation = state.burstGeneration;
    state.burstActive = true;
    state.burstItems = items;
    state.burstCycle = [];
    state.burstIndex = 0;
    state.burstPersona = persona;
    state.burstMix = mix;
    state.burstLastAudio = null;
    state.burstEndsAt = Date.now() + state.burstDuration * 1_000;
    state.active = true;
    state.mode = "burst";
    state.presetKind = "burst";
    setLevel(0.18);
    state.burstTimer = window.setTimeout(() => {
      if (isCurrentBurst(generation)) stopAll("BARRAGE COMPLETE — 0:00");
    }, state.burstDuration * 1_000);
    updateBurstCountdown(generation);
    playBurstPhrase(generation);
  }

  function createButton(label, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rq-button ${className}`.trim();
    button.dataset.action = action;
    button.textContent = label;
    return button;
  }

  function createControl(mode) {
    const host = document.createElement("div");
    host.setAttribute(OWNED_ATTRIBUTE, "true");
    host.dataset.ragequitMode = mode;
    const shadow = host.attachShadow({ mode: "closed" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = localUrl("style.css");
    shadow.append(stylesheet);

    const launcherGroup = document.createElement("div");
    launcherGroup.className = "rq-launcher-group";
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "rq-launcher";
    launcher.dataset.action = "launcher";
    launcher.setAttribute("aria-label", "SlopSlappy: react to this answer");
    launcher.setAttribute("aria-pressed", "false");
    launcher.title = "SlopSlappy: react to this answer";
    const mascot = document.createElement("img");
    mascot.src = localUrl("icons/icon-32.png");
    mascot.alt = "";
    mascot.width = 26;
    mascot.height = 26;
    const stopMark = document.createElement("span");
    stopMark.className = "rq-stop-mark";
    stopMark.setAttribute("aria-hidden", "true");
    launcher.append(mascot, stopMark);
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "rq-settings";
    settings.dataset.action = "settings";
    settings.textContent = "⋯";
    settings.title = "SlopSlappy languages, voices and settings";
    settings.setAttribute("aria-label", "Open SlopSlappy settings");
    settings.setAttribute("aria-haspopup", "dialog");
    settings.setAttribute("aria-expanded", "false");
    launcherGroup.append(launcher, settings);
    shadow.append(launcherGroup);

    const panel = document.createElement("section");
    panel.className = "rq-panel rq-popover";
    panel.setAttribute("popover", "manual");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "SlopSlappy settings");
    panel.tabIndex = -1;
    panel.innerHTML = `
      <div class="rq-shell">
        <div class="rq-popover-heading">
          <img class="rq-mark" src="${localUrl("icons/icon-48.png")}" width="32" height="32" alt="" aria-hidden="true">
          <span class="rq-brand-name">SlopSlappy</span>
          <button type="button" class="rq-close" data-action="close-settings" aria-label="Close SlopSlappy settings">×</button>
        </div>
        <div class="rq-controls">
          <p class="rq-details-note" data-action="placement" hidden></p>
          <button type="button" class="rq-button" data-action="pick-placement" hidden>PLACE BESIDE ANSWER…</button>
          <p class="rq-privacy">Hold-to-scream is never recorded. My Voice records only on explicit Start and Save.</p>
          <button type="button" class="rq-button rq-rage" data-action="rage" aria-label="Start or stop SlopSlappy">RAGE / 60 SEC</button>
          <div class="rq-row rq-quick-settings">
            <label class="rq-select-label">LANGUAGE <select data-action="language" aria-label="Generic curse language"></select></label>
            <label class="rq-volume">VOL <input data-action="volume" type="range" min="0" max="100" value="45" aria-label="Local audio volume"><output>45%</output></label>
          </div>
          <label class="rq-select-label">VOICE <select data-action="persona" aria-label="Playable persona"></select></label>
          <p class="rq-details-note">Choose a language or voice to play immediately.</p>
          <details class="rq-my-voice-disclosure">
            <summary>MY VOICE / FAVORITES</summary>
            <div class="rq-details-body">
              <p class="rq-details-note">Favorites are extension-local. Open My Voice to record, save, manage, or download them.</p>
              <label class="rq-select-label">SAVED FAVORITE <select data-action="personal-select" aria-label="Saved My Voice favorite"></select></label>
              <div class="rq-row">
                <button type="button" class="rq-button" data-action="refresh-personal">REFRESH</button>
                <button type="button" class="rq-button" data-action="play-personal">PLAY FAVORITE</button>
                <button type="button" class="rq-button" data-action="use-personal">USE AS RAGE</button>
              </div>
              <button type="button" class="rq-button rq-my-voice" data-action="open-studio">OPEN MY VOICE STUDIO</button>
            </div>
          </details>
          <details class="rq-more-controls">
            <summary>OPTIONS / MORE LOCAL CONTROLS</summary>
            <div class="rq-details-body">
              <p class="rq-details-note" data-action="persona-note"></p>
              <button type="button" class="rq-button rq-hold" data-action="hold" aria-label="Hold to scream at this answer. Microphone amplitude is analyzed locally only.">HOLD TO SCREAM AT IT</button>
              <button type="button" class="rq-button rq-red" data-action="silent" aria-pressed="false" aria-label="Start a five-second silent rage animation">SILENT RAGE</button>
              <button type="button" class="rq-button" data-action="scream" aria-label="Play bundled scream preset">SCREAM FOR ME</button>
              <p class="rq-preset-label">DEFAULT RAGE / BUNDLED CURSE</p>
              <p class="rq-meltdown-label">MELTDOWN / RAW LANGUAGE</p>
              <label class="rq-select-label">PHRASE <select data-action="phrase" aria-label="Curse phrase"></select></label>
              <p class="rq-preview" data-action="preview"></p>
              <p class="rq-intensity" data-action="intensity"></p>
              <button type="button" class="rq-button" data-action="curse" aria-label="Play selected local phrase">PLAY SELECTED PHRASE</button>
              <button type="button" class="rq-button" data-action="random" aria-label="Choose a random catalog phrase in the selected language">RANDOM PHRASE</button>
              <div class="rq-voice-options">
                <label class="rq-select-label">VOICE <select data-action="voice-actor" aria-label="Shout voice"><option value="man">Man · clear shout</option><option value="woman">Woman · clear shout</option></select></label>
                <label class="rq-select-label">EFFECT <select data-action="voice-style" aria-label="Shout effect"><option value="dry">Clear (default)</option><option value="radio">Radio distortion</option><option value="monster">Monster pitch</option></select></label>
              </div>
              <p class="rq-style-note">Clear is the default. Man and Woman differ on <code>*-meltdown</code> clips; every generic line has independently recorded Man and Woman performances. Calm sigh stays original and calm.</p>
              <div class="rq-row rq-presets" aria-label="Additional bundled presets">
                <button type="button" class="rq-button" data-action="sigh" aria-label="Play original calm sigh preset">CALM SIGH</button>
                <button type="button" class="rq-button" data-action="sound" aria-pressed="true" aria-label="Toggle local audio">SOUND: ON</button>
              </div>
              <p class="rq-sigh-note" data-action="sigh-note"></p>
              <p class="rq-preset-label">RAPID-FIRE / OPTIONAL SETUP</p>
              <div class="rq-row rq-burst-options">
                <label class="rq-burst-label">FOR <select data-action="burst-duration" aria-label="Rapid-fire duration"><option value="60">60 SEC</option><option value="120">120 SEC</option></select></label>
                <label class="rq-burst-label">SPEED <select data-action="burst-speed" aria-label="Rapid-fire speed"><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
                <label class="rq-burst-label">SCOPE <select data-action="burst-scope" aria-label="Rapid-fire phrase scope"><option value="language">LANG</option><option value="all">ALL</option></select></label>
                <label class="rq-burst-label">TIER <select data-action="reaction-tier" aria-label="Rapid-fire reaction intensity"><option value="meltdown">LONG RANTS</option><option value="all">SHORT CURSES</option></select></label>
              </div>
              <button type="button" class="rq-button rq-barrage" data-action="barrage" aria-label="Start a timed rapid-fire sequence of local bundled phrases">START RAPID-FIRE</button>
              <button type="button" class="rq-button rq-toggle" data-action="explicit" aria-pressed="true">LET IT SWEAR: ON</button>
            </div>
          </details>
          <p class="rq-status" role="status" aria-live="polite">READY — LOCAL ONLY</p>
        </div>
      </div>`;
    shadow.append(panel);

    const rage = panel.querySelector('[data-action="rage"]');
    const hold = panel.querySelector('[data-action="hold"]');
    const silent = panel.querySelector('[data-action="silent"]');
    const soundToggle = panel.querySelector('[data-action="sound"]');
    const explicitToggle = panel.querySelector('[data-action="explicit"]');
    const curse = panel.querySelector('[data-action="curse"]');
    const sigh = panel.querySelector('[data-action="sigh"]');
    const language = panel.querySelector('[data-action="language"]');
    const persona = panel.querySelector('[data-action="persona"]');
    const personaNote = panel.querySelector('[data-action="persona-note"]');
    const phrase = panel.querySelector('[data-action="phrase"]');
    const voiceActor = panel.querySelector('[data-action="voice-actor"]');
    const voiceStyle = panel.querySelector('[data-action="voice-style"]');
    const preview = panel.querySelector('[data-action="preview"]');
    const intensity = panel.querySelector('[data-action="intensity"]');
    const random = panel.querySelector('[data-action="random"]');
    const sighNote = panel.querySelector('[data-action="sigh-note"]');
    const burstDuration = panel.querySelector('[data-action="burst-duration"]');
    const burstSpeed = panel.querySelector('[data-action="burst-speed"]');
    const burstScope = panel.querySelector('[data-action="burst-scope"]');
    const reactionTier = panel.querySelector('[data-action="reaction-tier"]');
    const barrage = panel.querySelector('[data-action="barrage"]');
    const personalSelect = panel.querySelector(
      '[data-action="personal-select"]'
    );
    const personalRefresh = panel.querySelector(
      '[data-action="refresh-personal"]'
    );
    const personalPlay = panel.querySelector('[data-action="play-personal"]');
    const personalUse = panel.querySelector('[data-action="use-personal"]');
    const personalOpenButtons = panel.querySelectorAll(
      '[data-action="open-studio"]'
    );
    const volume = panel.querySelector('[data-action="volume"]');
    const volumeValue = panel.querySelector("output");
    const status = panel.querySelector(".rq-status");
    const control = {
      host,
      panel,
      launcherGroup,
      launcher,
      settings,
      silent,
      soundToggle,
      explicitToggle,
      curse,
      sigh,
      language,
      persona,
      personaNote,
      phrase,
      voiceActor,
      voiceStyle,
      preview,
      intensity,
      random,
      sighNote,
      burstDuration,
      burstSpeed,
      burstScope,
      reactionTier,
      barrage,
      rage,
      personalSelect,
      personalRefresh,
      personalPlay,
      personalUse,
      personalOpenButtons,
      volume,
      volumeValue,
      status,
    };
    state.controls.add(control);
    launcher.addEventListener("click", startPrimaryRage);
    panel
      .querySelector('[data-action="pick-placement"]')
      .addEventListener("click", () => {
        closeSettings();
        state.pickingPlacement = true;
        settings.title =
          "Click an action icon under the AI answer to place SlopSlappy. Escape cancels.";
        setStatus(
          "PLACEMENT: CLICK AN ACTION ICON UNDER THE AI ANSWER — ESCAPE CANCELS"
        );
      });
    settings.addEventListener("click", () => {
      if (panel.matches(":popover-open")) closeSettings(true);
      else {
        panel.showPopover();
        panel.scrollTop = 0;
        settings.setAttribute("aria-expanded", "true");
        positionSettings();
        // Nonmodal: tab order remains available; focus the first setting.
        window.requestAnimationFrame(() =>
          language.focus({ preventScroll: true })
        );
      }
    });
    panel
      .querySelector('[data-action="close-settings"]')
      .addEventListener("click", () => closeSettings(true));
    panel.addEventListener("toggle", () =>
      settings.setAttribute(
        "aria-expanded",
        String(panel.matches(":popover-open"))
      )
    );
    const resizeObserver = new ResizeObserver(() => positionSettings());
    resizeObserver.observe(panel);
    resizeObserver.observe(launcherGroup);
    control.resizeObserver = resizeObserver;

    let keyHolding = false;
    hold.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      try {
        hold.setPointerCapture(event.pointerId);
      } catch {
        // The window-level release listener below is still authoritative.
      }
      startMicrophone({ type: "pointer", pointerId: event.pointerId });
    });
    hold.addEventListener("pointerup", event =>
      releaseHold({ type: "pointer", pointerId: event.pointerId })
    );
    hold.addEventListener("pointercancel", event =>
      releaseHold({ type: "pointer", pointerId: event.pointerId })
    );
    hold.addEventListener("lostpointercapture", event =>
      releaseHold({ type: "pointer", pointerId: event.pointerId })
    );
    hold.addEventListener("keydown", event => {
      if (
        (event.code === "Space" || event.key === "Enter") &&
        !keyHolding &&
        !event.repeat
      ) {
        event.preventDefault();
        keyHolding = true;
        startMicrophone({ type: "key" });
      }
    });
    hold.addEventListener("keyup", event => {
      if ((event.code === "Space" || event.key === "Enter") && keyHolding) {
        event.preventDefault();
        keyHolding = false;
        releaseHold({ type: "key" });
      }
    });
    hold.addEventListener("blur", () => {
      if (keyHolding) {
        keyHolding = false;
        releaseHold({ type: "key" });
      }
    });

    panel
      .querySelector('[data-action="scream"]')
      .addEventListener("click", playScream);
    rage.addEventListener("click", startPrimaryRage);
    sigh.addEventListener("click", playSigh);
    curse.addEventListener("click", playCurse);
    persona.addEventListener("change", () => {
      const actorChoice = ["man", "woman"].includes(persona.value)
        ? persona.value
        : null;
      if (actorChoice) {
        state.voiceActor = actorChoice;
        useGenericSettings();
        return;
      }
      const next =
        persona.value === "generic" ||
        persona.value === "mix" ||
        state.personas.packs.some(pack => pack.id === persona.value)
          ? persona.value
          : state.personaId;
      if (next === state.personaId) return;
      state.personaId = next;
      const selected = selectedPersona();
      state.personalUseAsRage = false;
      if (selected) {
        state.languageId = selected.language;
        state.phraseId = phrasesForLanguage()[0]?.id || "";
      }
      if (state.active || state.audio || state.burstActive) {
        stopAll(
          selected
            ? `PERSONA CHANGED — ${selected.label} — STOPPED`
            : "GENERIC VOICE RESTORED — STOPPED"
        );
      } else {
        setStatus(
          selected
            ? `PERSONA: ${selected.label} — ${selected.languageLabel}`
            : "GENERIC MAN / WOMAN CONTROLS RESTORED"
        );
      }
      render();
    });
    language.addEventListener("change", () => {
      const next = language.value;
      stopAll("LANGUAGE CHANGED — STOPPED");
      const persona = selectedPersona();
      if (persona && persona.language !== next) state.personaId = "generic";
      state.personalUseAsRage = false;
      state.burstScope = "language";
      state.burstSpeed = 1;
      state.voiceStyle = "dry";
      state.languageId = next;
      state.phraseId = phrasesForLanguage()[0]?.id || "";
      render();
    });
    phrase.addEventListener("change", () => {
      const next = phrase.value;
      useGenericSettings();
      state.phraseId = next;
      render();
    });
    voiceActor.addEventListener("change", () => {
      if (!["man", "woman"].includes(voiceActor.value)) return;
      state.voiceActor = voiceActor.value;
      useGenericSettings();
      if (state.active || state.audio || state.burstActive) {
        stopAll(`VOICE CHANGED — ${voiceActorLabel()} — STOPPED`);
      } else {
        setStatus(`VOICE: ${voiceActorLabel()}`);
      }
    });
    voiceStyle.addEventListener("change", () => {
      if (!["radio", "dry", "monster"].includes(voiceStyle.value)) return;
      state.voiceStyle = voiceStyle.value;
      useGenericSettings();
      if (state.audio || state.burstActive) {
        stopAll(`EFFECT CHANGED — ${voiceStyleLabel()} — STOPPED`);
      } else {
        setStatus(`EFFECT: ${voiceStyleLabel()}`);
      }
    });
    random.addEventListener("click", () => {
      if (!state.explicitOn) {
        setStatus("CURSES DISABLED — LET IT SWEAR IS OFF");
        return;
      }
      const phrases = phrasesForLanguage();
      if (!phrases.length) {
        setStatus("CURSE UNAVAILABLE — CATALOG MISSING");
        return;
      }
      state.phraseId = phrases[Math.floor(Math.random() * phrases.length)].id;
      setStatus("RANDOM PHRASE READY — CURSE PLAYS THE PREVIEW");
      playCurse();
    });
    burstDuration.addEventListener("change", () => {
      state.burstDuration = Number(burstDuration.value);
      state.personalUseAsRage = false;
      stopAll("DURATION CHANGED — STOPPED");
    });
    burstSpeed.addEventListener("change", () => {
      state.burstSpeed = Number(burstSpeed.value);
      state.personalUseAsRage = false;
      stopAll("SPEED CHANGED — STOPPED");
    });
    burstScope.addEventListener("change", () => {
      state.burstScope = burstScope.value;
      useGenericSettings();
    });
    reactionTier.addEventListener("change", () => {
      state.reactionIntensity =
        reactionTier.value === "all" ? "all" : "meltdown";
      useGenericSettings();
    });
    for (const select of [
      persona,
      language,
      voiceActor,
      voiceStyle,
      burstDuration,
      burstSpeed,
      burstScope,
      reactionTier,
    ]) {
      select.addEventListener("change", () => startPrimaryRage());
    }
    phrase.addEventListener("change", playCurse);
    barrage.addEventListener("click", startBarrage);
    personalSelect.addEventListener("change", () => {
      state.personalFavoriteId = personalSelect.value;
      render();
      void playPersonalFavorite();
    });
    panel
      .querySelector(".rq-my-voice-disclosure")
      .addEventListener("toggle", event => {
        if (event.target.open) void refreshPersonalFavorites();
      });
    personalRefresh.addEventListener(
      "click",
      () => void refreshPersonalFavorites()
    );
    personalPlay.addEventListener("click", () => void playPersonalFavorite());
    personalUse.addEventListener("click", () => {
      if (!state.personalFavoriteId) return;
      state.personalUseAsRage = !state.personalUseAsRage;
      setStatus(
        state.personalUseAsRage
          ? "RAGE WILL PLAY THIS MY VOICE FAVORITE — 30 SECOND LIMIT"
          : "RAGE RESET TO LOCAL RAPID-FIRE"
      );
    });
    personalOpenButtons.forEach(button =>
      button.addEventListener("click", () => void openPersonalStudio())
    );
    explicitToggle.addEventListener("click", () => {
      state.explicitOn = !state.explicitOn;
      if (
        !state.explicitOn &&
        (state.presetKind === "curse" || state.burstActive)
      ) {
        stopAll("CURSES DISABLED — BARRAGE STOPPED");
      } else if (!state.explicitOn) {
        setStatus("CURSES DISABLED — LET IT SWEAR IS OFF");
      } else {
        render();
      }
    });
    silent.addEventListener("click", startSilentRage);
    soundToggle.addEventListener("click", () => {
      state.soundOn = !state.soundOn;
      if (!state.soundOn && state.burstActive) {
        stopAll("SOUND OFF — BARRAGE STOPPED");
      } else if (!state.soundOn && state.audio) {
        stopAll("SOUND OFF — AUDIO STOPPED");
      } else {
        render();
      }
    });
    volume.addEventListener("input", () => {
      state.volume = Number(volume.value) / 100;
      if (state.audio) state.audio.volume = state.volume;
      render();
    });
    render();
    return control;
  }

  function collectAssistantTargets() {
    const candidates = new Set();
    for (const selector of siteSelectors()) {
      for (const node of document.querySelectorAll(selector)) {
        if (!(node instanceof Element) || node.closest(`[${OWNED_ATTRIBUTE}]`))
          continue;
        candidates.add(node);
      }
    }
    // Prefer an outer response container when selectors overlap; no response text is read.
    return [...candidates]
      .filter(
        candidate =>
          ![...candidates].some(
            other => other !== candidate && other.contains(candidate)
          )
      )
      .sort((left, right) =>
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1
      );
  }

  // Only structure/button metadata is inspected. Never read conversation text.
  function isAssistantRow(row) {
    if (
      row.matches("[data-user-message-actions]") ||
      row.closest(
        '[data-message-role="user"], [data-message-author-role="user"], [data-turn="user"]'
      )
    )
      return false;
    return !row.closest(`[${OWNED_ATTRIBUTE}]`);
  }

  function actionMetadata(button) {
    const parts = [
      "aria-label",
      "data-testid",
      "data-test-id",
      "title",
      "data-action",
    ].map(name => button.getAttribute(name) || "");
    // SVG symbol identifiers, not answer text or HTML serialization.
    for (const icon of button.querySelectorAll(
      "svg,[data-icon],[data-tooltip]"
    )) {
      for (const name of [
        "aria-label",
        "data-icon",
        "data-tooltip",
        "name",
        "id",
      ])
        parts.push(icon.getAttribute(name) || "");
    }
    for (const symbol of button.querySelectorAll("svg use")) {
      parts.push(
        symbol.getAttribute("href") || symbol.getAttribute("xlink:href") || ""
      );
    }
    return parts.join(" ").toLowerCase().replace(/[-_]+/g, " ");
  }

  function actionButtons(container) {
    return [...container.querySelectorAll('button, [role="button"]')].filter(
      button => !button.closest(`[${OWNED_ATTRIBUTE}]`)
    );
  }

  function isCopyAction(button) {
    return /\bcopy\b/.test(actionMetadata(button));
  }

  function isDistinctAssistantAction(button) {
    return /read\s*aloud|text\s*to\s*speech|\btts\b|\bretry\b|regenerate|thumbs?\s*(up|down)|good\s*response|bad\s*response|positive\s*feedback|negative\s*feedback|response\s*(like|dislike)/.test(
      actionMetadata(button)
    );
  }

  function isExcludedActionArea(row) {
    return Boolean(
      row.closest(
        '[data-testid*="sidebar"], [data-test-id*="sidebar"], [id="sidebar"], [class~="sidebar"]'
      ) ||
        row.closest(
          `form, nav, aside, header, footer, [role="navigation"], [role="complementary"], [contenteditable="true"], [data-user-message-actions], [data-message-role="user"], [data-message-author-role="user"], [data-turn="user"], [data-testid="composer"], [data-testid="chat-input"], [data-testid="composer-container"], [${OWNED_ATTRIBUTE}]`
        )
    );
  }

  // The signed-in ChatGPT shell can omit all assistant-role data attributes.
  // Require an answer-specific action signature rather than guessing by layout.
  function collectChatGPTActionRows() {
    if (
      !["chatgpt.com", "chat.openai.com"].some(
        host =>
          window.location.hostname === host ||
          window.location.hostname.endsWith(`.${host}`)
      )
    )
      return [];
    const rows = new Set();
    for (const copy of document.querySelectorAll('button, [role="button"]')) {
      if (!isCopyAction(copy) || isExcludedActionArea(copy)) continue;
      let row = copy.parentElement;
      for (let depth = 0; row && depth < 5; depth++, row = row.parentElement) {
        if (
          row === document.body ||
          row.matches('main, [role="main"], [data-conversation-transcript]') ||
          isExcludedActionArea(row)
        )
          break;
        const buttons = actionButtons(row);
        const copyCount = buttons.filter(isCopyAction).length;
        // A conversation container with multiple answers isn't a toolbar.
        if (
          copyCount > 1 ||
          buttons.length > 10 ||
          row.querySelector('textarea,input,[contenteditable="true"]')
        )
          break;
        if (copyCount === 1 && buttons.some(isDistinctAssistantAction)) {
          // Require the action buttons to occupy a compact horizontal row.
          const recognized = buttons.filter(
            button => isCopyAction(button) || isDistinctAssistantAction(button)
          );
          const boxes = recognized
            .map(button => button.getBoundingClientRect())
            .filter(box => box.width && box.height);
          if (
            boxes.length < 2 ||
            Math.max(...boxes.map(box => box.top + box.height / 2)) -
              Math.min(...boxes.map(box => box.top + box.height / 2)) >
              30
          )
            break;
          rows.add(row);
          break;
        }
      }
    }
    return [...rows].sort((left, right) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1
    );
  }

  function findActionRow(target) {
    const selector =
      '[data-assistant-message-actions], [data-message-actions]:not([data-user-message-actions]), [data-testid="message-actions"], [data-testid="assistant-actions"]';
    // Prefer an explicit assistant row within the nearest response container.
    const semanticTurn =
      target.closest(
        'article[data-turn="assistant"], li[data-message-role="assistant"], model-response'
      ) ||
      target.closest(
        '[data-message-role="assistant"], [data-message-author-role="assistant"], article[data-turn="assistant"], model-response, [data-testid="assistant-message"], [data-is-assistant="true"]'
      );
    let container = target;
    for (
      let depth = 0;
      container && depth < 6;
      depth++, container = container.parentElement
    ) {
      if (
        container === document.body ||
        container === document.documentElement ||
        container.matches('[data-conversation-transcript], main, [role="main"]')
      )
        break;
      // Never borrow an older answer's toolbar while this reply is streaming.
      const nestedResponses = [
        ...container.querySelectorAll(siteSelectors().join(",")),
      ].filter(node => !node.closest(`[${OWNED_ATTRIBUTE}]`));
      if (
        !semanticTurn &&
        nestedResponses.some(
          node =>
            node !== target && !node.contains(target) && !target.contains(node)
        )
      )
        break;
      const rows = [...container.querySelectorAll(selector)].filter(
        isAssistantRow
      );
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) break; // Do not choose an unrelated answer's toolbar.
      // Older sites: find a shared parent of multiple semantic answer-action buttons.
      const buttons = [
        ...container.querySelectorAll("button[data-testid],button[aria-label]"),
      ].filter(
        button =>
          !button.closest(`[${OWNED_ATTRIBUTE}]`) &&
          /copy|thumb|good.response|bad.response|regenerate|retry/i.test(
            `${button.getAttribute("data-testid") || ""} ${button.getAttribute("aria-label") || ""}`
          )
      );
      const groups = [...new Set(buttons.map(button => button.parentElement))];
      const group = groups.find(
        parent =>
          parent &&
          buttons.filter(button => button.parentElement === parent).length >=
            2 &&
          isAssistantRow(parent) &&
          !parent.matches('form,[role="form"]')
      );
      if (group) return group;
      if (container === semanticTurn) break;
    }
    const turn = semanticTurn || target;
    return collectChatGPTActionRows().find(row => turn.contains(row)) || null;
  }

  function positionSettings() {
    const control = state.control;
    if (!control || !control.panel.matches(":popover-open")) return;
    const { panel, launcherGroup } = control;
    const gap = 8;
    const padding = 12;
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const offsetX = viewport?.offsetLeft || 0;
    const offsetY = viewport?.offsetTop || 0;
    panel.style.width = `${Math.max(180, Math.min(320, width - padding * 2))}px`;
    panel.style.maxHeight = `${Math.max(80, Math.min(520, height - padding * 2))}px`;
    const anchor = launcherGroup.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const left = Math.max(
      offsetX + padding,
      Math.min(anchor.left, offsetX + width - bounds.width - padding)
    );
    const below = anchor.bottom + gap;
    const top =
      below + bounds.height <= offsetY + height - padding
        ? below
        : Math.max(
            offsetY + padding,
            Math.min(
              anchor.top - gap - bounds.height,
              offsetY + height - bounds.height - padding
            )
          );
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function closeSettings(restoreFocus = false) {
    const control = state.control;
    if (!control?.panel.matches(":popover-open")) return;
    control.panel.hidePopover();
    control.settings.setAttribute("aria-expanded", "false");
    if (restoreFocus && control.settings.isConnected)
      control.settings.focus({ preventScroll: true });
  }

  function onOutsideFocus(event) {
    if (state.control && !event.composedPath().includes(state.control.host))
      closeSettings();
  }

  function onOutsidePointer(event) {
    if (
      state.pickingPlacement &&
      state.control &&
      !event.composedPath().includes(state.control.host)
    ) {
      state.pickingPlacement = false;
      const clicked =
        event.target instanceof Element
          ? event.target.closest('button,[role="button"]')
          : null;
      let row = clicked?.parentElement;
      for (let depth = 0; row && depth < 4; depth++, row = row.parentElement) {
        if (
          isExcludedActionArea(row) ||
          row.matches('main,[role="main"],body') ||
          row.querySelector('textarea,input,[contenteditable="true"]')
        )
          break;
        const buttons = actionButtons(row);
        if (buttons.length >= 2 && buttons.length <= 10) {
          event.preventDefault();
          event.stopImmediatePropagation();
          state.manualRow = row;
          state.control.host.dataset.ragequitMode = "toolbar";
          row.append(state.control.host);
          setStatus("PLACED BY YOU — LOCAL ONLY");
          return;
        }
      }
      setStatus(
        "COULD NOT PLACE — OPEN SETTINGS AND PICK AN ANSWER ACTION ROW"
      );
      return;
    }
    if (state.control && !event.composedPath().includes(state.control.host))
      closeSettings();
  }

  // Move the same launcher with new replies; preserve audio, settings and timers.
  function scan() {
    state.scanFrame = null;
    if (state.destroyed) return;
    if (!state.control) state.control = createControl("inline");
    const host = state.control.host;
    const targets = collectAssistantTargets();
    const latest = targets[targets.length - 1] || null;
    const explicitRows = siteSelectors().length
      ? [
          ...document.querySelectorAll("[data-assistant-message-actions]"),
        ].filter(isAssistantRow)
      : [];
    const row = latest
      ? findActionRow(latest)
      : explicitRows[explicitRows.length - 1] ||
        collectChatGPTActionRows().at(-1) ||
        (state.manualRow?.isConnected ? state.manualRow : null);
    if (row?.isConnected) {
      if (host.parentElement !== row) {
        host.dataset.ragequitMode = "toolbar";
        row.append(host);
        render();
      }
    } else if (latest?.parentElement && latest.isConnected) {
      if (
        host.parentElement !== latest.parentElement ||
        host.previousSibling !== latest
      ) {
        host.dataset.ragequitMode = "inline";
        latest.parentElement.insertBefore(host, latest.nextSibling);
        render();
      }
    } else {
      const home = document.body || document.documentElement;
      if (
        host.parentElement !== home ||
        host.dataset.ragequitMode !== "fallback"
      ) {
        host.dataset.ragequitMode = "fallback";
        home.append(host);
        render();
      }
    }
    positionSettings();
  }

  function scheduleScan() {
    if (state.scanFrame !== null || state.destroyed) return;
    state.scanFrame = window.requestAnimationFrame(scan);
  }

  function cleanup() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.personalGeneration += 1;
    clearPersonalTimer();
    clearRageTimer();
    clearBurst();
    stopMicrophone();
    stopAudio();
    closeSettings();
    state.control?.resizeObserver?.disconnect();
    state.observer?.disconnect();
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("focusin", onOutsideFocus, true);
    window.removeEventListener("resize", positionSettings);
    window.removeEventListener("scroll", positionSettings, true);
    window.visualViewport?.removeEventListener("resize", positionSettings);
    window.visualViewport?.removeEventListener("scroll", positionSettings);
    if (state.scanFrame !== null) window.cancelAnimationFrame(state.scanFrame);
    window.removeEventListener("pointerup", onGlobalPointerRelease, true);
    window.removeEventListener("pointercancel", onGlobalPointerCancel, true);
    window.removeEventListener("blur", onWindowBlur, true);
    document.removeEventListener("visibilitychange", onVisibilityChange, true);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    document.removeEventListener(DESTROY_EVENT, cleanup);
    window.removeEventListener("pagehide", cleanup);
    for (const control of state.controls) control.host.remove();
    state.controls.clear();
    state.control = null;
    state.responseControls.clear();
    state.root?.remove();
    delete window[APP_KEY];
  }

  function onGlobalPointerRelease(event) {
    releaseHold({ type: "pointer", pointerId: event.pointerId });
  }

  function onGlobalPointerCancel(event) {
    releaseHold({ type: "pointer", pointerId: event.pointerId });
  }

  function onWindowBlur(event) {
    // Registered in the capture phase, so this also sees every element on the
    // page losing focus. Only the window itself losing focus should stop audio.
    if (event.target !== window) return;
    if (state.holding || state.active || state.audio)
      stopAll("STOPPED — WINDOW LOST FOCUS");
  }

  function onVisibilityChange() {
    if (document.hidden && (state.holding || state.active || state.audio)) {
      stopAll("STOPPED — PAGE HIDDEN");
    }
  }

  function onDocumentKeydown(event) {
    if (event.key === "Escape") {
      state.pickingPlacement = false;
      closeSettings(true);
    }
    if (
      event.key === "Escape" &&
      (state.holding || state.active || state.audio)
    ) {
      stopAll("STOPPED — ESCAPE");
    }
  }

  function initialize() {
    state.root = document.createElement("div");
    state.root.setAttribute(ROOT_ATTRIBUTE, "true");
    state.root.hidden = true;
    document.documentElement.append(state.root);

    window.addEventListener("pointerup", onGlobalPointerRelease, true);
    window.addEventListener("pointercancel", onGlobalPointerCancel, true);
    window.addEventListener("blur", onWindowBlur, true);
    document.addEventListener("visibilitychange", onVisibilityChange, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("focusin", onOutsideFocus, true);
    window.addEventListener("resize", positionSettings);
    window.addEventListener("scroll", positionSettings, true);
    window.visualViewport?.addEventListener("resize", positionSettings);
    window.visualViewport?.addEventListener("scroll", positionSettings);
    document.addEventListener(DESTROY_EVENT, cleanup);
    window.addEventListener("pagehide", cleanup, { once: true });

    state.observer = new MutationObserver(records => {
      if (
        records.every(
          record =>
            record.target instanceof Element &&
            record.target.closest(`[${OWNED_ATTRIBUTE}]`)
        )
      )
        return;
      if (!state.root?.isConnected) {
        cleanup();
        return;
      }
      scheduleScan();
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-turn",
        "data-message-author-role",
        "data-message-role",
        "data-is-assistant",
        "data-author-role",
        "data-role",
        "data-author",
        "data-testid",
        "data-assistant-message-actions",
        "data-message-actions",
        "data-user-message-actions",
        "aria-label",
        "title",
        "href",
        "role",
      ],
    });
    scan();
    // Favorite metadata is requested only by deliberate My Voice interaction.
  }

  window[APP_KEY] = { destroy: cleanup };
  initialize();
})();
