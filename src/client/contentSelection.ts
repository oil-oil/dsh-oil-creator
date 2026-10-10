import { useEffect, useState } from "react";

import {
  browserCreatorStorage,
  loadCreatorUiState,
  saveCreatorUiState,
} from "./persistence.ts";

type Listener = () => void;

const listeners = new Set<Listener>();
const libraryListeners = new Set<Listener>();
const profileListeners = new Set<Listener>();
const initialUi = loadCreatorUiState(browserCreatorStorage());
let selectedId = initialUi.selectedId;
let libraryEpoch = 0;
let profileEpoch = 0;
function emit(): void {
  for (const listener of listeners) listener();
}

function emitLibrary(): void {
  for (const listener of libraryListeners) listener();
}

export function bumpLibrary(): void {
  libraryEpoch += 1;
  emitLibrary();
}

export function getLibraryEpoch(): number {
  return libraryEpoch;
}

export function subscribeLibrary(listener: Listener): () => void {
  libraryListeners.add(listener);
  return () => {
    libraryListeners.delete(listener);
  };
}

export function useLibraryEpoch(): number {
  const [epoch, setEpoch] = useState(getLibraryEpoch);
  useEffect(() => subscribeLibrary(() => {
    setEpoch(getLibraryEpoch());
  }), []);
  return epoch;
}

export function bumpProfile(): void {
  profileEpoch += 1;
  for (const listener of profileListeners) listener();
}

export function getProfileEpoch(): number {
  return profileEpoch;
}

export function subscribeProfile(listener: Listener): () => void {
  profileListeners.add(listener);
  return () => {
    profileListeners.delete(listener);
  };
}

export function useProfileEpoch(): number {
  const [epoch, setEpoch] = useState(getProfileEpoch);
  useEffect(() => subscribeProfile(() => {
    setEpoch(getProfileEpoch());
  }), []);
  return epoch;
}

export function inspectorIsOpen(): boolean {
  return selectedId !== null;
}

export function getSelectedContentId(): string | null {
  return selectedId;
}

export function setSelectedContentId(id: string | null): void {
  if (selectedId === id) return;
  selectedId = id;
  const state = loadCreatorUiState(browserCreatorStorage());
  saveCreatorUiState(browserCreatorStorage(), { ...state, selectedId });
  emit();
}

export function subscribeSelectedContentId(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSelectedContentId(): [string | null, (id: string | null) => void] {
  const [selectedId, setSelectedId] = useState(getSelectedContentId);
  useEffect(() => subscribeSelectedContentId(() => {
    setSelectedId(getSelectedContentId());
  }), []);
  return [selectedId, setSelectedContentId];
}
