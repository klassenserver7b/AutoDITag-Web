import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../src/core/descriptor';
import { buildPlan } from '../src/core/plan';
import type { PickedFile } from '../src/core/types';

function picked(name: string): PickedFile {
  return {
    name,
    relativePath: `music/${name}`,
    file: new File([], name, { type: 'audio/mpeg' }),
  };
}

const DESCRIPTOR = [
  '01_Waltz; Artist -- Dance',
  '02_Tango; Artist2 -- Dance2',
  '03_Foxtrott; Artist3 -- Dance3',
].join('\n');

describe('buildPlan', () => {
  it('matches the files to the descriptor entries', () => {
    const { entries } = parseDescriptor(DESCRIPTOR);
    const plan = buildPlan(entries, [picked('01-Song.mp3'), picked('02-Song.mp3'), picked('03-Song.mp3')]);

    expect(plan.tracks).toHaveLength(3);
    expect(plan.tracks.every((track) => track.status === 'ok')).toBe(true);
    expect(plan.tracks[0]?.source?.name).toBe('01-Song.mp3');
    expect(plan.tracks[0]?.targetName).toBe('01_Waltz; Artist -- Dance.mp3');
    expect(plan.unmatched).toHaveLength(0);
  });

  it('matches unpadded file names', () => {
    const { entries } = parseDescriptor('1_Waltz; Artist -- Dance');
    const plan = buildPlan(entries, [picked('1-Song.mp3')]);
    expect(plan.tracks[0]?.status).toBe('ok');
    expect(plan.tracks[0]?.source?.name).toBe('1-Song.mp3');
  });

  it('reports missing files', () => {
    const { entries } = parseDescriptor(DESCRIPTOR);
    const plan = buildPlan(entries, [picked('01-Song.mp3')]);
    expect(plan.tracks[0]?.status).toBe('ok');
    expect(plan.tracks[1]?.status).toBe('missing');
    expect(plan.tracks[1]?.warnings[0]).toContain('No file found matching pattern');
  });

  it('never assigns one file to two tracks', () => {
    const { entries } = parseDescriptor(DESCRIPTOR);
    const plan = buildPlan(entries, [picked('01-Song.mp3')]);
    const used = plan.tracks.filter((track) => track.source).map((track) => track.source?.name);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports files without a descriptor entry', () => {
    const { entries } = parseDescriptor(DESCRIPTOR);
    const plan = buildPlan(entries, [picked('01-Song.mp3'), picked('99-Extra.mp3')]);
    expect(plan.unmatched.map((file) => file.name)).toEqual(['99-Extra.mp3']);
    expect(plan.warnings[0]).toContain("No descriptor entry matches '99-Extra.mp3'");
  });

  it('warns when several files match the same track', () => {
    const { entries } = parseDescriptor('01_Waltz; Artist -- Dance');
    const plan = buildPlan(entries, [picked('01-Song.mp3'), picked('01-Other.mp3')]);
    expect(plan.tracks[0]?.warnings[0]).toContain('Multiple files found for track 01');
    expect(plan.tracks[0]?.status).toBe('ok');
  });

  it('prefers the already renamed file on a re-run', () => {
    const { entries } = parseDescriptor(DESCRIPTOR);
    const plan = buildPlan(entries, [
      picked('01-Old.mp3'),
      picked('01_Waltz; Artist -- Dance.mp3'),
      picked('02_Tango; Artist2 -- Dance2.mp3'),
      picked('03_Foxtrott; Artist3 -- Dance3.mp3'),
    ]);
    expect(plan.tracks[0]?.source?.name).toBe('01_Waltz; Artist -- Dance.mp3');
    expect(plan.tracks.every((track) => track.status === 'ok')).toBe(true);
  });

  it('reports a matching file that is not an mp3 file', () => {
    const { entries } = parseDescriptor(DESCRIPTOR);
    const plan = buildPlan(entries, [picked('01-Song.flac'), picked('notes.txt')]);
    expect(plan.tracks[0]?.status).toBe('invalid-source');
    expect(plan.tracks[0]?.warnings.join(' ')).toContain('is not an mp3 file');
    expect(plan.tracks[0]?.source).toBeNull();
    expect(plan.tracks[1]?.status).toBe('missing');
    expect(plan.unmatched).toHaveLength(0);
  });
});
