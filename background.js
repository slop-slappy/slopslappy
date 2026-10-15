/* global chrome */
"use strict";

const SUPPORTED_ROOTS = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
  "manus.im",
];
const ROOT_SELECTOR = '[data-ragequit-extension-root="true"]';
const DESTROY_EVENT = "__ragequit_extension_destroy__";
const PERSONAL_DB_NAME = "ragequit-personal-voices";
const PERSONAL_STORE = "recordings";
const PERSONAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function validPersonalId(id) {
  return typeof id === "string" && PERSONAL_ID_PATTERN.test(id);
}

function openPersonalDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(
        new Error("Local recording storage is unavailable in this browser")
      );
      return;
    }
    const request = indexedDB.open(PERSONAL_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PERSONAL_STORE)) {
        database.createObjectStore(PERSONAL_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error || new Error("Could not open local recording storage")
      );
  });
}

function requestResult(request, errorMessage) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(errorMessage));
  });
}

function recordingMetadata(record) {
  if (!record || !validPersonalId(record.id)) return null;
  return {
    id: record.id,
    name:
      typeof record.name === "string" ? record.name.slice(0, 80) : "My voice",
    favorite: Boolean(record.favorite),
    date: typeof record.date === "string" ? record.date : "",
    duration: Number.isFinite(record.duration) ? record.duration : 0,
  };
}

async function listPersonalRecordings() {
  const database = await openPersonalDatabase();
  try {
    const transaction = database.transaction(PERSONAL_STORE, "readonly");
    const records = await requestResult(
      transaction.objectStore(PERSONAL_STORE).getAll(),
      "Could not read local recordings"
    );
    return records
      .map(recordingMetadata)
      .filter(Boolean)
      .sort((left, right) =>
        String(right.date).localeCompare(String(left.date))
      );
  } finally {
    database.close();
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

async function getPersonalRecording(id) {
  if (!validPersonalId(id)) throw new Error("Invalid personal recording ID");
  const database = await openPersonalDatabase();
  try {
    const transaction = database.transaction(PERSONAL_STORE, "readonly");
    const record = await requestResult(
      transaction.objectStore(PERSONAL_STORE).get(id),
      "Could not read local recording"
    );
    if (!record?.audio || !(record.audio instanceof Blob)) {
      throw new Error("That local recording is unavailable");
    }
    const bytes = new Uint8Array(await record.audio.arrayBuffer());
    return {
      metadata: recordingMetadata(record),
      mimeType: record.audio.type || "audio/webm",
      base64: bytesToBase64(bytes),
    };
  } finally {
    database.close();
  }
}

function isSupportedUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return false;
    return SUPPORTED_ROOTS.some(
      root => url.hostname === root || url.hostname.endsWith(`.${root}`)
    );
  } catch {
    return false;
  }
}

async function setUnsupportedState(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "!" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d83a2e" });
  await chrome.action.setTitle({
    tabId,
    title:
      "SlopSlappy works only on ChatGPT, Claude, Gemini, and Manus HTTPS chat pages",
  });
}

async function clearActionState(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({
    tabId,
    title: "Toggle SlopSlappy controls on this page",
  });
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id) return;

  if (!isSupportedUrl(tab.url || "")) {
    try {
      await setUnsupportedState(tab.id);
    } catch (error) {
      console.warn("SlopSlappy could not update its toolbar state:", error);
    }
    return;
  }

  try {
    const [{ result: alreadyInjected } = {}] =
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: selector => Boolean(document.querySelector(selector)),
        args: [ROOT_SELECTOR],
      });

    if (alreadyInjected) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: eventName => {
          document.dispatchEvent(new Event(eventName));
          document
            .querySelector('[data-ragequit-extension-root="true"]')
            ?.remove();
        },
        args: [DESTROY_EVENT],
      });
    } else {
      const [packsResponse, personasResponse] = await Promise.all([
        fetch(chrome.runtime.getURL("packs.json")),
        fetch(chrome.runtime.getURL("personas.json")),
      ]);
      if (!packsResponse.ok || !personasResponse.ok) {
        throw new Error(
          `Bundled catalogs could not load (${packsResponse.status}/${personasResponse.status})`
        );
      }
      const [packs, personas] = await Promise.all([
        packsResponse.json(),
        personasResponse.json(),
      ]);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        func: catalog => {
          window.__ragequit_packs__ = catalog;
        },
        args: [packs],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        func: catalog => {
          window.__ragequit_personas__ = catalog;
        },
        args: [personas],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        files: ["content.js"],
      });
    }

    await clearActionState(tab.id);
  } catch (error) {
    // A navigation, a restricted frame, or a site CSP race can invalidate activeTab access.
    console.warn("SlopSlappy injection failed:", error);
    try {
      await setUnsupportedState(tab.id);
    } catch {
      // Nothing else is safe or useful to do here.
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own studio and isolated content scripts may request data.
  if (
    sender.id !== chrome.runtime.id ||
    !message ||
    typeof message !== "object"
  ) {
    return false;
  }

  if (message.type === "open-studio") {
    chrome.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch(error =>
        sendResponse({
          ok: false,
          error: error.message || "Could not open My Voice studio",
        })
      );
    return true;
  }

  if (message.type === "list-personal") {
    listPersonalRecordings()
      .then(recordings => sendResponse({ ok: true, recordings }))
      .catch(error =>
        sendResponse({
          ok: false,
          error: error.message || "Could not read local recordings",
        })
      );
    return true;
  }

  if (message.type === "get-personal") {
    if (!validPersonalId(message.id)) {
      sendResponse({ ok: false, error: "Invalid personal recording ID" });
      return false;
    }
    getPersonalRecording(message.id)
      .then(recording => sendResponse({ ok: true, recording }))
      .catch(error =>
        sendResponse({
          ok: false,
          error: error.message || "Could not load local recording",
        })
      );
    return true;
  }

  return false;
});
