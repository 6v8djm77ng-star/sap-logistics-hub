/**
 * Content & Copy Agent — Zod schemas for input and output.
 *
 * The agent is LLM-only and DB-free. Input is validated before any LLM call;
 * output is validated after JSON.parse so we never return malformed payloads.
 */
import { z } from 'zod';

export const BRANDS = [
  'DAVO',
  'NOVO',
  'Tineco',
  'Hurom',
  'Ritter',
  'Blendtec',
  'Ankarsrum',
  'Ascaso',
  'OIG',
  'Unico',
];

export const CONTENT_TYPES = [
  'facebook_post',
  'linkedin_post',
  'google_ad',
  'sms',
  'whatsapp_message',
  'newsletter',
  'radio_script',
  'video_script',
  'retail_copy',
  'customer_reply',
  'supplier_email',
  'press_release',
];

export const LANGUAGES = ['hebrew', 'english'];

export const GOALS = [
  'awareness',
  'sales',
  'launch',
  'retention',
  'retail_support',
  'service',
  'supplier_response',
  'pr',
];

export const TONES = [
  'premium',
  'direct',
  'emotional',
  'professional',
  'authoritative',
  'diplomatic',
  'aggressive_but_polite',
];

export const inputSchema = z.object({
  brand: z.enum(BRANDS),
  product: z.string().trim().max(500).optional(),
  content_type: z.enum(CONTENT_TYPES),
  language: z.enum(LANGUAGES),
  target_audience: z.string().trim().min(1).max(500),
  goal: z.enum(GOALS),
  tone: z.enum(TONES),
  key_points: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  constraints: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  source_text: z.string().trim().max(8000).optional(),
});

export const outputSchema = z.object({
  main_copy: z.string().min(1),
  alternative_versions: z.array(z.string()).default([]),
  headline_options: z.array(z.string()).default([]),
  cta_options: z.array(z.string()).default([]),
  cialdini_principles_used: z.array(z.string()).default([]),
  risk_notes: z.array(z.string()).default([]),
  missing_information: z.array(z.string()).default([]),
});
