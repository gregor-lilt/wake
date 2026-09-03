/** Muted vector-basemap palette, one hue per top-level region. */
export type RGB = [number, number, number];
export type ThemeName = 'dark' | 'light';

const HUES = [205, 152, 32, 272, 96];
/** Any number of top-level directories: golden angle past the tuned five. */
const hueOf = (i: number) => (i < HUES.length ? HUES[i] : (HUES[0] + i * 137.508) % 360);

function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (k: number): number => {
    const kk = (k + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Four tone steps, then the fourth again, from the terrain outwards. Level 0
 * is the terrain itself, which is why the dark ramp starts at the land fill's
 * own lightness.
 */
const STEP_DARK = 0.024;
const STEP_LIGHT = 0.026;
const LAND_L_DARK = 0.118;
const LAND_L_LIGHT = 0.925;
const stepOf = (level: number) => Math.max(0, Math.min(4, level));
const lightDark = (level: number) => LAND_L_DARK + stepOf(level) * STEP_DARK;
const lightLight = (level: number) => LAND_L_LIGHT - stepOf(level) * STEP_LIGHT;
/** A top-level region carries the hue; descendants keep it at lower saturation. */
const satOf = (level: number) => (stepOf(level) <= 1 ? 0.22 : 0.13);

export interface Theme {
  name: ThemeName;
  background: RGB;
  /** the whole repository rect, drawn under the regions on the export path */
  landFill: RGB;
  landLine: RGB;
  /**
   * The fill ramp (docs/design.md section 4). `level` is the directory's
   * nesting level: 0 is the terrain the repository root draws, 1 a top-level
   * region, and each level after that one step lighter in the dark theme and
   * one step darker in the light one, four steps and then the fourth again.
   * A top-level region carries its hue; its descendants keep the hue at lower
   * saturation, so the user reads depth from tone before any label.
   */
  districtFill(region: number, level: number): RGB;
  /** A 1 px border at fixed contrast against the PARENT's fill. */
  districtLine(region: number, level: number): RGB;
  cityFill(region: number, t: number): RGB;
  /** the sheet, which is the tile at the schematic and source tiers: paper */
  sheetFill: RGB;
  buildingFill(kind: number, region: number): RGB;
  roadLocal: RGB;
  roadMotorway: RGB;
  label: RGB;
  labelHalo: RGB;
  cityLabel: RGB;
  traffic: RGB;
  css: {
    bg: string; fg: string; panel: string; border: string; accent: string;
    codeBg: string; codeFg: string;
    /** the jump bar's ground: opaque, so it needs no backdrop filter */
    jump: string;
  };
}

export function makeTheme(name: ThemeName): Theme {
  const dark = name === 'dark';
  if (dark) {
    return {
      name,
      background: [17, 20, 24],
      landFill: [26, 29, 34],
      landLine: [78, 84, 92],
      districtFill: (r, level) => hsl(hueOf(r), satOf(level), lightDark(level)),
      // Fixed contrast against the parent's fill, which is one step back.
      districtLine: (r, level) => hsl(hueOf(r), satOf(level) + 0.10, lightDark(level - 1) + 0.19),
      // A file tile is paper at every band, not just where the sheet appears:
      // one tone, faintly tinted by its region, so nothing inverts on the way
      // into the schematic tier (phase 1 drew a light tile under a dark sheet).
      cityFill: (r, t) => hsl(hueOf(r), 0.16, 0.093 + 0.022 * t),
      // Paper on a desk: one step off the district fill, dark enough for the
      // github-dark token colours the worker produces.
      sheetFill: [20, 24, 30],
      buildingFill: (k, r) => hsl(hueOf(r) + (k === 0 ? 12 : k === 1 ? 0 : k === 2 ? -10 : 24), 0.30, k === 0 ? 0.72 : k === 1 ? 0.64 : k === 2 ? 0.57 : 0.50),
      roadLocal: [128, 138, 148],
      roadMotorway: [206, 178, 116],
      label: [236, 240, 244],
      labelHalo: [12, 14, 17],
      cityLabel: [204, 212, 220],
      traffic: [255, 176, 80],
      css: {
        bg: '#111418', fg: '#e6eaee', panel: 'rgba(22,26,31,0.86)',
        border: 'rgba(255,255,255,0.12)', accent: '#ffb050',
        // the sheet, matched to the Shiki theme the worker uses
        codeBg: 'rgb(20,24,30)', codeFg: '#c9d1d9',
        jump: '#171b21'
      }
    };
  }
  return {
    name,
    background: [246, 244, 240],
    landFill: [238, 235, 229],
    landLine: [168, 166, 160],
    districtFill: (r, level) => hsl(hueOf(r), satOf(level) + 0.05, lightLight(level)),
    districtLine: (r, level) => hsl(hueOf(r), satOf(level) + 0.12, lightLight(level - 1) - 0.30),
    cityFill: (r, t) => hsl(hueOf(r), 0.22, 0.985 - 0.028 * t),
    sheetFill: [252, 252, 250],
    buildingFill: (k, r) => hsl(hueOf(r) + (k === 0 ? 12 : k === 1 ? 0 : k === 2 ? -10 : 24), 0.34, k === 0 ? 0.40 : k === 1 ? 0.48 : k === 2 ? 0.56 : 0.62),
    roadLocal: [128, 130, 128],
    roadMotorway: [150, 116, 48],
    label: [40, 44, 50],
    labelHalo: [250, 249, 246],
    cityLabel: [86, 92, 100],
    traffic: [230, 110, 20],
    css: {
      bg: '#f6f4f0', fg: '#22262c', panel: 'rgba(255,255,255,0.9)',
      border: 'rgba(0,0,0,0.14)', accent: '#c65a10',
      codeBg: 'rgb(252,252,250)', codeFg: '#24292f',
      jump: '#fbfaf7'
    }
  };
}
