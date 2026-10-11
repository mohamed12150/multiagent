// Preact + htm — the whole UI is written with tagged templates (no build step).
import { h, render, Fragment, createContext, toChildArray, cloneElement } from '../../vendor/preact.module.js';
import {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer, useId, useErrorBoundary,
} from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';

export const html = htm.bind(h);
export {
  h, render, Fragment, createContext, toChildArray, cloneElement,
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer, useId, useErrorBoundary,
};

/** Join class names, skipping falsy values. */
export function cls(...parts) {
  return parts.flat().filter(Boolean).join(' ');
}
