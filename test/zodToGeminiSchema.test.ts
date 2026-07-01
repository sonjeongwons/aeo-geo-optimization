/**
 * test/zodToGeminiSchema.test.ts — regression coverage for the zod -> Gemini
 * responseSchema converter, specifically the ZodDefault unwrapping bug:
 * a `z.array(...).default([])` field used to fall through to the string fallback,
 * so Gemini emitted a string/CSV and strict .safeParse rejected it (PARSE_FAILED).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToGeminiSchema } from '../src/domain/mention.schema.js';

describe('zodToGeminiSchema — wrapper unwrapping', () => {
  it('emits type:array for a defaulted array of strings (not the string fallback)', () => {
    const schema = z.object({ aliases: z.array(z.string()).default([]) });
    const out = zodToGeminiSchema(schema) as { properties: Record<string, { type: string; items?: { type: string } }> };
    expect(out.properties.aliases.type).toBe('array');
    expect(out.properties.aliases.items?.type).toBe('string');
  });

  it('emits type:array of object for a defaulted array of objects', () => {
    const schema = z.object({
      competitors: z.array(z.object({ name: z.string(), aliases: z.array(z.string()).default([]) })).default([]),
    });
    const out = zodToGeminiSchema(schema) as { properties: Record<string, { type: string; items?: { type: string; properties?: Record<string, { type: string }> } }> };
    expect(out.properties.competitors.type).toBe('array');
    expect(out.properties.competitors.items?.type).toBe('object');
    expect(out.properties.competitors.items?.properties?.name.type).toBe('string');
  });

  it('a defaulted field is NOT marked required (Gemini may omit it)', () => {
    const schema = z.object({ a: z.string(), b: z.array(z.string()).default([]) });
    const out = zodToGeminiSchema(schema) as { required?: string[] };
    expect(out.required).toContain('a');
    expect(out.required ?? []).not.toContain('b');
  });

  it('unwraps ZodEffects (.superRefine) to the base object type', () => {
    const schema = z.object({ x: z.number().int() }).superRefine(() => {});
    const out = zodToGeminiSchema(schema) as { type: string; properties?: Record<string, { type: string }> };
    expect(out.type).toBe('object');
    expect(out.properties?.x.type).toBe('integer');
  });

  it('still handles nullable + enum + number correctly', () => {
    const schema = z.object({
      rank: z.number().int().nullable(),
      sentiment: z.enum(['positive', 'neutral', 'negative']),
    });
    const out = zodToGeminiSchema(schema) as { properties: Record<string, { type: string; nullable?: boolean; enum?: string[] }> };
    expect(out.properties.rank.type).toBe('integer');
    expect(out.properties.rank.nullable).toBe(true);
    expect(out.properties.sentiment.enum).toEqual(['positive', 'neutral', 'negative']);
  });
});
