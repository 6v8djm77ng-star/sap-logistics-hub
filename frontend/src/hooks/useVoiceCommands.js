/**
 * Voice command hook for the driver app.
 * Uses the Web Speech API (SpeechRecognition).
 *
 * Recognises (Hebrew):
 *   "ניווט"       → navigate to current stop
 *   "הגעתי"       → mark arrived at current stop
 *   "סיימתי"      → open POD dialog (sign + photo)
 *   "התקשר"       → call customer
 *   "כשל"         → open failure report
 *   "הבא"         → next stop
 *   "קודם"        → previous stop
 */
import { useEffect, useRef, useState, useCallback } from 'react';

const COMMANDS = [
  { phrases: ['ניווט', 'נווט', 'נווט אליו', 'תנווט', 'נווט לכתובת'], action: 'navigate' },
  { phrases: ['הגעתי', 'הגענו', 'אני כאן', 'הגעתי ליעד'], action: 'arrive' },
  { phrases: ['סיימתי', 'סיים', 'סיימנו', 'גמרתי', 'מסירה'], action: 'complete' },
  { phrases: ['התקשר', 'תתקשר', 'חייג', 'טלפון'], action: 'call' },
  { phrases: ['כשל', 'בעיה', 'תקלה', 'דווח כשל'], action: 'failure' },
  { phrases: ['הבא', 'עצירה הבאה', 'הבאה'], action: 'next' },
  { phrases: ['קודם', 'הקודם', 'אחורה'], action: 'prev' },
  { phrases: ['עזרה', 'מה אפשר לומר'], action: 'help' },
];

function matchCommand(text) {
  const norm = text.trim().toLowerCase();
  for (const c of COMMANDS) {
    for (const p of c.phrases) {
      if (norm.includes(p)) return c.action;
    }
  }
  return null;
}

export function useVoiceCommands({ onCommand, enabled = true } = {}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastHeard, setLastHeard] = useState('');
  const recognitionRef = useRef(null);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const r = new SR();
    r.lang = 'he-IL';
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (event) => {
      const results = event.results;
      const last = results[results.length - 1];
      if (!last.isFinal) return;
      const text = last[0].transcript || '';
      setLastHeard(text);
      const action = matchCommand(text);
      if (action && onCommand) onCommand(action, text);
    };
    r.onerror = (e) => {
      console.warn('[voice] error', e.error);
      if (e.error === 'no-speech') return; // benign
    };
    r.onend = () => {
      // Auto-restart if still enabled (continuous mode)
      if (enabled && recognitionRef.current === r) {
        try { r.start(); } catch {}
      } else {
        setListening(false);
      }
    };
    recognitionRef.current = r;
    return () => {
      recognitionRef.current = null;
      try { r.stop(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(() => {
    const r = recognitionRef.current;
    if (!r) return;
    try {
      r.start();
      setListening(true);
    } catch (e) {
      // already started
      setListening(true);
    }
  }, []);

  const stop = useCallback(() => {
    const r = recognitionRef.current;
    if (!r) return;
    try { r.stop(); } catch {}
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    listening ? stop() : start();
  }, [listening, start, stop]);

  return { supported, listening, lastHeard, start, stop, toggle };
}

export const VOICE_COMMANDS = COMMANDS;
