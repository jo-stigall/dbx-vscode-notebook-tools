/**
 * Random numbers that are the same on each run.
 *
 * The demo data and the tests use this file. A fixed seed always gives the
 * same sequence, so the demo tables contain the same rows on each computer.
 */

/** A function that returns the next random number, from 0 (included) to 1 (not included). */
export type Rng = () => number;

/**
 * Make a random number generator from a seed. This is the "mulberry32" algorithm.
 *
 * @example
 * const rng = makeRng(42);
 * rng()   // 0.6011037519201636, on each run
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Get a random number from the normal distribution with mean 0 and standard deviation 1.
 *
 * The function takes two numbers from `rng`. The demo data uses it for
 * `amount`: exp(3.9 + 0.7 * normal(rng)) gives amounts with a median of
 * about 49.
 *
 * @example
 * normal(makeRng(42))   // -1.2848381576290195, on each run
 */
export function normal(rng: Rng): number {
  // Box-Muller. 1 - rng() is never 0, so the logarithm is always finite.
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/**
 * Select one value. The function selects a value with a larger weight more frequently.
 *
 * @example
 * weighted(rng, [['web', 60], ['store', 30], ['phone', 10]])   // 'web' in 60% of the calls
 *
 * @param choices  Each entry is a value and its weight. The weights do not need to add up to 100.
 */
export function weighted<T>(rng: Rng, choices: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of choices) total += w;
  let x = rng() * total;
  for (const [value, w] of choices) {
    x -= w;
    if (x < 0) return value;
  }
  return (choices[choices.length - 1] as readonly [T, number])[0];
}
