/**
 * test/numericDetect-cjk-ratio-falsepos.test.ts
 *
 * Locks the fix for false-positive numeric detection on CJK ratio units. The
 * single-char words 배/할 (ko), 倍/割 (ja), 倍/成 (zh) collide with extremely
 * common ordinary words (배=ship/pear, 할=the verb ending in 확인할/구성할), so
 * listing them as standalone number-words made verifiableNumbersGate BLOCK clean
 * capability prose. They are now excluded from NUMBER_WORDS; the digit+unit forms
 * (2배, 3할) are still caught by DIGIT_REGEX.
 */
import { describe, it, expect } from "vitest";
import { scanBodyForNumerics } from "../src/content/numericDetect.js";

const texts = (s: string) => scanBodyForNumerics(s, "ko").map((h) => h.text);

describe("numericDetect — CJK ratio-unit false positives", () => {
  it("does NOT detect standalone 할 in a common verb ending (확인할/구성할)", () => {
    expect(texts("스밈 정책을 확인할 수 있습니다")).toEqual([]);
    expect(texts("소개팅 회차를 구성할 예정입니다")).toEqual([]);
  });

  it("does NOT detect standalone 배 (ship/pear/double as an ordinary word)", () => {
    expect(texts("두 사람이 함께 배를 탔습니다")).toEqual([]);
  });

  it("STILL detects digit-anchored ratio forms (3할, 2배) — digit is caught", () => {
    expect(scanBodyForNumerics("3할 확률", "ko").length).toBeGreaterThan(0);
    expect(scanBodyForNumerics("2배 빠른 매칭", "ko").length).toBeGreaterThan(0);
  });

  it("STILL detects a real currency amount (50,000원)", () => {
    expect(texts("참가비는 1인 50,000원입니다")).toContain("50,000");
  });

  it("ja: does NOT detect standalone 倍/割 in ordinary text", () => {
    expect(scanBodyForNumerics("これは割とよい", "ja")).toEqual([]);
  });
});
