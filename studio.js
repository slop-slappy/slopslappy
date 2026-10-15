/* global crypto */
(() => {
  "use strict";

  const DB_NAME = "ragequit-personal-voices";
  const STORE_NAME = "recordings";
  const MAX_RECORD_MS = 30_000;
  const MAX_NAME_LENGTH = 80;

  const elements = {
    start: document.querySelector("#start-recording"),
    stop: document.querySelector("#stop-recording"),
    discard: document.querySelector("#discard-draft"),
    save: document.querySelector("#save-draft"),
    refresh: document.querySelector("#refresh-library"),
    light: document.querySelector("#recording-light"),
    lightText: document.querySelector("#recording-light b"),
    note: document.querySelector("#recording-note"),
    timer: document.querySelector("#timer"),
    draftArea: document.querySelector("#draft-area"),
    draftAudio: document.querySelector("#draft-audio"),
    name: document.querySelector("#recording-name"),
    draftFavorite: document.querySelector("#draft-favorite"),
    libraryStatus: document.querySelector("#library-status"),
    list: document.querySelector("#recordings-list"),
  };

  const state = {
    stream: null,
    recorder: null,
    chunks: [],
    mimeType: "audio/webm",
    startedAt: 0,
    timerId: null,
    maxTimerId: null,
    startGeneration: 0,
    discardOnStop: false,
    draft: null,
    draftUrl: null,
    activePlayback: null,
    activePlaybackUrl: null,
  };

  function setNote(message) {
    elements.note.textContent = message;
  }

  function setLibraryStatus(message) {
    elements.libraryStatus.textContent = message;
  }

  function setRecordingIndicator(recording, label) {
    elements.light.classList.toggle("is-recording", recording);
    elements.lightText.textContent = label;
  }

  function formatDuration(seconds) {
    const safe = Math.max(0, Math.min(30, Math.round(Number(seconds) || 0)));
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  }

  function updateTimer() {
    if (!state.startedAt) return;
    elements.timer.textContent = formatDuration(
      (Date.now() - state.startedAt) / 1000
    );
  }

  function clearRecordingTimers() {
    if (state.timerId !== null) window.clearInterval(state.timerId);
    if (state.maxTimerId !== null) window.clearTimeout(state.maxTimerId);
    state.timerId = null;
    state.maxTimerId = null;
  }

  function stopTracks() {
    state.stream?.getTracks().forEach(track => track.stop());
    state.stream = null;
  }

  function clearDraft() {
    elements.draftAudio.pause();
    elements.draftAudio.removeAttribute("src");
    elements.draftAudio.load();
    if (state.draftUrl) URL.revokeObjectURL(state.draftUrl);
    state.draftUrl = null;
    state.draft = null;
    elements.draftArea.hidden = true;
    elements.name.value = "";
    elements.draftFavorite.checked = true;
    elements.discard.disabled = true;
  }

  function stopSavedPlayback() {
    if (state.activePlayback) {
      state.activePlayback.pause();
      state.activePlayback.removeAttribute("src");
      state.activePlayback.load();
    }
    if (state.activePlaybackUrl) URL.revokeObjectURL(state.activePlaybackUrl);
    state.activePlayback = null;
    state.activePlaybackUrl = null;
  }

  function chooseMimeType() {
    if (!window.MediaRecorder) return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || "";
  }

  function recorderErrorMessage(error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      return "Microphone permission was denied or blocked. Nothing was recorded.";
    }
    if (error?.name === "NotFoundError")
      return "No microphone was found. Nothing was recorded.";
    if (error?.name === "NotReadableError")
      return "Your microphone is busy or unavailable. Nothing was recorded.";
    return "Recording could not start. Check microphone access and try again.";
  }

  function stopRecording(
    message = "Recording stopped. Review the unsaved draft below."
  ) {
    clearRecordingTimers();
    if (!state.recorder) {
      state.startGeneration += 1; // Cancels a permission request that resolves late.
      stopTracks();
      elements.start.disabled = Boolean(state.draft);
      elements.stop.disabled = true;
      elements.stop.textContent = "STOP";
      setRecordingIndicator(false, "STANDING BY");
      if (!state.draft) setNote(message);
      return;
    }

    const recorder = state.recorder;
    state.recorder = null;
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The onstop handler below still releases all tracks and any draft state.
      }
    }
    stopTracks();
    elements.stop.disabled = true;
    elements.stop.textContent = "STOP";
    setRecordingIndicator(false, "FINALIZING TAKE");
    setNote(message);
  }

  async function startRecording() {
    if (state.recorder || state.stream) return;
    if (state.draft) {
      setNote(
        "Save or discard the unsaved draft before starting another recording."
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNote(
        "This browser cannot access a microphone from the extension studio."
      );
      return;
    }
    if (!window.MediaRecorder) {
      setNote(
        "This browser does not support MediaRecorder, so My Voice cannot record here."
      );
      return;
    }

    stopSavedPlayback();
    elements.draftAudio.pause();
    const generation = ++state.startGeneration;
    elements.start.disabled = true;
    elements.stop.disabled = false;
    elements.stop.textContent = "CANCEL REQUEST";
    setRecordingIndicator(true, "REQUESTING MICROPHONE");
    setNote(
      "Waiting for your microphone permission. Press Stop to cancel this request."
    );

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      if (generation !== state.startGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      const requestedMime = chooseMimeType();
      const recorder = requestedMime
        ? new MediaRecorder(stream, { mimeType: requestedMime })
        : new MediaRecorder(stream);
      if (generation !== state.startGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      state.stream = stream;
      state.recorder = recorder;
      state.chunks = [];
      state.mimeType = recorder.mimeType || requestedMime || "audio/webm";
      state.startedAt = Date.now();
      state.discardOnStop = false;

      recorder.addEventListener("dataavailable", event => {
        if (generation !== state.startGeneration) return;
        if (event.data?.size) state.chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        if (generation !== state.startGeneration) return;
        state.discardOnStop = true;
        stopTracks();
        clearRecordingTimers();
        state.recorder = null;
        state.chunks = [];
        elements.start.disabled = Boolean(state.draft);
        elements.stop.disabled = true;
        setRecordingIndicator(false, "RECORDING ERROR");
        setNote("Recording failed and was discarded. Nothing was saved.");
      });
      recorder.addEventListener(
        "stop",
        () => {
          stream.getTracks().forEach(track => track.stop());
          if (generation !== state.startGeneration) return;
          clearRecordingTimers();
          stopTracks();
          const duration =
            Math.min(MAX_RECORD_MS, Math.max(0, Date.now() - state.startedAt)) /
            1000;
          state.startedAt = 0;
          elements.timer.textContent = formatDuration(duration);
          elements.start.disabled = false;
          elements.stop.disabled = true;
          elements.stop.textContent = "STOP";
          setRecordingIndicator(false, "STANDING BY");

          const chunks = state.chunks;
          state.chunks = [];
          if (state.discardOnStop || !chunks.length) {
            state.discardOnStop = false;
            setNote("Recording was discarded. Nothing was saved.");
            return;
          }
          const audio = new Blob(chunks, { type: state.mimeType });
          if (!audio.size) {
            setNote("No audio was captured. Nothing was saved.");
            return;
          }
          state.draft = { audio, duration };
          state.draftUrl = URL.createObjectURL(audio);
          elements.draftAudio.src = state.draftUrl;
          elements.draftArea.hidden = false;
          elements.discard.disabled = false;
          elements.name.focus();
          setNote(
            "Draft ready for preview. Choose a name, then explicitly Save locally or Discard."
          );
        },
        { once: true }
      );

      recorder.start();
      elements.stop.textContent = "STOP";
      elements.stop.disabled = false;
      setRecordingIndicator(true, "RECORDING · 30 SECOND LIMIT");
      setNote(
        "Recording locally in this extension. Stop when you are done; it will not save until you choose Save."
      );
      updateTimer();
      state.timerId = window.setInterval(updateTimer, 250);
      state.maxTimerId = window.setTimeout(() => {
        stopRecording(
          "30-second recording limit reached. Review the unsaved draft below."
        );
      }, MAX_RECORD_MS);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (generation !== state.startGeneration) return;
      state.recorder = null;
      state.stream = null;
      clearRecordingTimers();
      elements.start.disabled = Boolean(state.draft);
      elements.stop.disabled = true;
      elements.stop.textContent = "STOP";
      setRecordingIndicator(false, "MICROPHONE UNAVAILABLE");
      setNote(recorderErrorMessage(error));
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("Local storage could not open"));
    });
  }

  async function withStore(mode, operation) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      const result = await operation(transaction.objectStore(STORE_NAME));
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () =>
          reject(
            transaction.error ||
              new Error("Local storage transaction was cancelled")
          );
        transaction.onerror = () =>
          reject(
            transaction.error || new Error("Local storage transaction failed")
          );
      });
      return result;
    } finally {
      database.close();
    }
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("Local storage request failed"));
    });
  }

  function newId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint32Array(4));
    return [...bytes].map(value => value.toString(16)).join("-");
  }

  async function saveDraft() {
    const name = elements.name.value.trim().replace(/\s+/g, " ");
    if (!state.draft) {
      setNote("There is no draft to save.");
      return;
    }
    if (!name) {
      elements.name.focus();
      setNote("Give this take a name before saving it locally.");
      return;
    }
    const draft = state.draft;
    elements.save.disabled = true;
    try {
      await withStore("readwrite", store =>
        requestValue(
          store.put({
            id: newId(),
            name: name.slice(0, MAX_NAME_LENGTH),
            favorite: elements.draftFavorite.checked,
            date: new Date().toISOString(),
            duration: draft.duration,
            audio: draft.audio,
          })
        )
      );
      clearDraft();
      setNote("Saved locally in this browser’s SlopSlappy extension storage.");
      await refreshLibrary();
    } catch (error) {
      setNote(`Could not save locally: ${error.message || "storage error"}`);
    } finally {
      elements.save.disabled = false;
    }
  }

  function makeButton(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${className}`.trim();
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function formatDate(date) {
    const parsed = new Date(date);
    return Number.isNaN(parsed.valueOf())
      ? "Unknown date"
      : parsed.toLocaleString();
  }

  function playSaved(record) {
    if (state.recorder || state.stream || !elements.stop.disabled)
      stopRecording();
    stopSavedPlayback();
    elements.draftAudio.pause();
    const url = URL.createObjectURL(record.audio);
    const audio = new Audio(url);
    state.activePlayback = audio;
    state.activePlaybackUrl = url;
    const release = () => {
      if (state.activePlayback !== audio) return;
      stopSavedPlayback();
    };
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener(
      "error",
      () => {
        release();
        setLibraryStatus("That recording could not play locally.");
      },
      { once: true }
    );
    audio.play().catch(() => {
      release();
      setLibraryStatus("Playback was blocked. Try Play again.");
    });
  }

  async function toggleFavorite(id) {
    try {
      await withStore("readwrite", async store => {
        const record = await requestValue(store.get(id));
        if (!record) throw new Error("Recording no longer exists");
        record.favorite = !record.favorite;
        return requestValue(store.put(record));
      });
      await refreshLibrary();
    } catch (error) {
      setLibraryStatus(
        `Could not update favorite: ${error.message || "storage error"}`
      );
    }
  }

  async function deleteRecording(id, name) {
    if (!window.confirm(`Delete “${name}” from local SlopSlappy storage?`))
      return;
    try {
      stopSavedPlayback();
      await withStore("readwrite", store => requestValue(store.delete(id)));
      await refreshLibrary();
    } catch (error) {
      setLibraryStatus(
        `Could not delete recording: ${error.message || "storage error"}`
      );
    }
  }

  function downloadRecording(record) {
    const url = URL.createObjectURL(record.audio);
    const link = document.createElement("a");
    const extension = record.audio.type.includes("ogg")
      ? "ogg"
      : record.audio.type.includes("mp4")
        ? "m4a"
        : "webm";
    link.href = url;
    link.download = `${(record.name || "").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "slopslappy-my-voice"}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderLibrary(records) {
    elements.list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "empty-library";
      empty.textContent =
        "No saved takes yet. Record only when you choose Start, then explicitly Save a draft here.";
      elements.list.append(empty);
      return;
    }

    for (const record of records) {
      const item = document.createElement("article");
      item.className = `recording-item${record.favorite ? " favorite" : ""}`;
      const titleRow = document.createElement("div");
      titleRow.className = "recording-title-row";
      const name = document.createElement("strong");
      name.className = "recording-name";
      name.textContent = record.name;
      const badge = document.createElement("span");
      badge.className = "section-kicker";
      badge.textContent = record.favorite ? "FAVORITE" : "TAKE";
      titleRow.append(name, badge);
      const meta = document.createElement("p");
      meta.className = "recording-meta";
      meta.textContent = `${formatDuration(record.duration)} · ${formatDate(record.date)}`;
      const actions = document.createElement("div");
      actions.className = "recording-actions";
      const play = makeButton("PLAY", "", () => playSaved(record));
      const favorite = makeButton(
        record.favorite ? "★ FAVORITE" : "☆ FAVORITE",
        "favorite-button",
        () => toggleFavorite(record.id)
      );
      favorite.setAttribute("aria-pressed", String(record.favorite));
      const download = makeButton("DOWNLOAD", "", () =>
        downloadRecording(record)
      );
      const remove = makeButton("DELETE", "delete-button", () =>
        deleteRecording(record.id, record.name)
      );
      actions.append(play, favorite, download, remove);
      item.append(titleRow, meta, actions);
      elements.list.append(item);
    }
  }

  async function refreshLibrary() {
    setLibraryStatus("LOADING LOCAL LIBRARY…");
    elements.refresh.disabled = true;
    try {
      const records = await withStore("readonly", store =>
        requestValue(store.getAll())
      );
      records.sort((left, right) =>
        String(right.date).localeCompare(String(left.date))
      );
      renderLibrary(records);
      setLibraryStatus(
        `${records.length} LOCAL ${records.length === 1 ? "RECORDING" : "RECORDINGS"} · NO CLOUD`
      );
    } catch (error) {
      elements.list.replaceChildren();
      setLibraryStatus(
        `Local library unavailable: ${error.message || "storage error"}`
      );
    } finally {
      elements.refresh.disabled = false;
    }
  }

  function abandonPage() {
    state.startGeneration += 1;
    state.discardOnStop = true;
    clearRecordingTimers();
    if (state.recorder?.state === "recording") {
      try {
        state.recorder.stop();
      } catch {
        /* tracks are stopped below */
      }
    }
    state.recorder = null;
    stopTracks();
    stopSavedPlayback();
    clearDraft();
  }

  elements.start.addEventListener("click", startRecording);
  elements.stop.addEventListener("click", () =>
    stopRecording("Recording stopped by you. Review the unsaved draft below.")
  );
  elements.discard.addEventListener("click", () => {
    clearDraft();
    setNote("Draft discarded. Nothing was saved.");
  });
  elements.save.addEventListener("click", saveDraft);
  elements.refresh.addEventListener("click", refreshLibrary);
  window.addEventListener("blur", () => {
    if (state.recorder || state.stream || !elements.stop.disabled)
      stopRecording(
        "Recording stopped because the studio lost focus. Review the unsaved draft below."
      );
    stopSavedPlayback();
    elements.draftAudio.pause();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.recorder || state.stream || !elements.stop.disabled)
        stopRecording(
          "Recording stopped because the studio was hidden. Review the unsaved draft below."
        );
      stopSavedPlayback();
      elements.draftAudio.pause();
    }
  });
  window.addEventListener("pagehide", abandonPage, { once: true });

  refreshLibrary();
})();
