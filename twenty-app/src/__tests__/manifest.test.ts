import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  getFieldUniversalIdentifier,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadEntities } from 'src/__tests__/utils/load-entities';
import { BUTTONS, type ButtonKey } from 'src/constants/buttons';
import {
  DECISION_TYPE_OPTIONS,
  OPENING_STATUS_OPTIONS,
} from 'src/constants/select-options';
import * as IDS from 'src/constants/universal-identifiers';
import {
  APPLICATION_UNIVERSAL_IDENTIFIER,
  BUTTON_IDS,
  NAVIGATION_IDS,
  OBJECT_IDS,
  TODAY_IDS,
} from 'src/constants/universal-identifiers';
import { buildAvailabilityExpression } from 'src/utils/build-availability-expression.util';

type Field = {
  universalIdentifier: string;
  name: string;
  type: string;
  objectUniversalIdentifier?: string;
  options?: { value: string }[];
  relationTargetObjectMetadataUniversalIdentifier?: string;
  relationTargetFieldMetadataUniversalIdentifier?: string;
  universalSettings?: { relationType?: string; joinColumnName?: string };
};
type ObjectConfig = {
  universalIdentifier: string;
  nameSingular: string;
  labelIdentifierFieldMetadataUniversalIdentifier: string;
  fields: Field[];
};

const SRC = path.resolve(__dirname, '..');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') {
    out.push(value);
  } else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      collectStrings(inner, out);
    }
  }

  return out;
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(full);
    }

    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });

let objects: ObjectConfig[] = [];
let standaloneFields: Field[] = [];
const fieldsById = new Map<string, Field & { objectId: string }>();

beforeAll(async () => {
  objects = (await loadEntities<ObjectConfig>('objects')).map((e) => e.config);
  standaloneFields = (await loadEntities<Field>('fields')).map((e) => e.config);

  for (const object of objects) {
    for (const field of object.fields) {
      fieldsById.set(field.universalIdentifier, {
        ...field,
        objectId: object.universalIdentifier,
      });
    }
  }
  for (const field of standaloneFields) {
    fieldsById.set(field.universalIdentifier, {
      ...field,
      objectId: field.objectUniversalIdentifier as string,
    });
  }
});

describe('universal identifiers', () => {
  it('are unique v4 UUIDs', () => {
    const ids = collectStrings(
      Object.entries(IDS)
        .filter(([key]) => key !== 'APP_DISPLAY_NAME' && key !== 'APP_DESCRIPTION')
        .map(([, value]) => value),
    );

    expect(ids.length).toBeGreaterThan(200);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('data model', () => {
  it('defines the sixteen objects', () => {
    expect(objects.map((o) => o.nameSingular).sort()).toEqual(
      [
        'application',
        'control',
        'decision',
        'document',
        'documentRevision',
        'emailDraft',
        'engagement',
        'escalation',
        'keywordQuestion',
        'opening',
        'positioning',
        'proposal',
        'resumeVersion',
        'run',
        'screeningQuestion',
        'verification',
      ].sort(),
    );
  });

  it('gives every object a label field it defines', () => {
    for (const object of objects) {
      const ids = object.fields.map((f) => f.universalIdentifier);

      expect(ids).toContain(object.labelIdentifierFieldMetadataUniversalIdentifier);
    }
  });

  it('pairs every relation both ways', () => {
    const relations = [...fieldsById.values()].filter((f) => f.type === 'RELATION');

    expect(relations.length).toBeGreaterThan(20);
    for (const field of relations) {
      const target = fieldsById.get(
        field.relationTargetFieldMetadataUniversalIdentifier as string,
      );

      expect(target, `${field.name} target field`).toBeDefined();
      expect(target?.objectId).toBe(field.relationTargetObjectMetadataUniversalIdentifier);
      expect(target?.relationTargetFieldMetadataUniversalIdentifier).toBe(
        field.universalIdentifier,
      );
      expect(target?.relationTargetObjectMetadataUniversalIdentifier).toBe(field.objectId);

      const sides = [field.universalSettings?.relationType, target?.universalSettings?.relationType].sort();

      expect(sides).toEqual(['MANY_TO_ONE', 'ONE_TO_MANY']);
      if (field.universalSettings?.relationType === 'MANY_TO_ONE') {
        expect(field.universalSettings.joinColumnName).toBe(`${field.name}Id`);
      }
    }
  });

  it('has exactly the harness statuses on opening.status', () => {
    const pipeline = readFileSync(path.resolve(SRC, '..', '..', 'tools', 'pipeline.ts'), 'utf8');
    const block = pipeline.match(/const VALID_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\};/);

    expect(block).not.toBeNull();
    const harness = [...(block?.[1] ?? '').matchAll(/^\s*([a-z_]+):\s*\[/gm)].map((m) =>
      m[1].toUpperCase(),
    );
    const status = fieldsById.get(IDS.FIELD_IDS.opening.status);

    expect(harness).toHaveLength(16);
    expect(status?.options?.map((o) => o.value).sort()).toEqual([...harness].sort());
    expect(OPENING_STATUS_OPTIONS.map((o) => o.value).sort()).toEqual([...harness].sort());
  });

  it('keeps SELECT values in UPPER_SNAKE case', () => {
    for (const field of fieldsById.values()) {
      for (const option of field.options ?? []) {
        expect(option.value).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('adds kind to company', () => {
    const kind = fieldsById.get(IDS.FIELD_IDS.company.kind);

    expect(kind?.objectId).toBe(STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier);
    expect(kind?.options?.map((o) => o.value)).toEqual(['END_CLIENT', 'AGENCY', 'PLATFORM']);
  });

  it('has no send action and no retry action anywhere', () => {
    expect(DECISION_TYPE_OPTIONS.map((o) => o.value)).not.toContain('RETRY_NOW');
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');

      expect(text, file).not.toContain('SEND_EMAIL');
      expect(text, file).not.toContain('RETRY_NOW');
    }
  });
});

describe('views, navigation and pages', () => {
  const systemField = (objectId: string, name: string) =>
    getFieldUniversalIdentifier({
      applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
      objectUniversalIdentifier: objectId,
      name,
    });

  it('reference existing objects and fields', async () => {
    const views = await loadEntities<{
      objectUniversalIdentifier: string;
      mainGroupByFieldMetadataUniversalIdentifier?: string;
      fields?: { fieldMetadataUniversalIdentifier: string }[];
      filters?: { fieldMetadataUniversalIdentifier: string }[];
      sorts?: { fieldMetadataUniversalIdentifier: string }[];
    }>('views');

    expect(views).toHaveLength(7);
    for (const { file, config } of views) {
      const objectFieldIds = new Set(
        [...fieldsById.values()]
          .filter((f) => f.objectId === config.objectUniversalIdentifier)
          .map((f) => f.universalIdentifier),
      );
      objectFieldIds.add(systemField(config.objectUniversalIdentifier, 'createdAt'));

      expect(Object.values(OBJECT_IDS), file).toContain(config.objectUniversalIdentifier);
      const referenced = [
        config.mainGroupByFieldMetadataUniversalIdentifier,
        ...(config.fields ?? []).map((f) => f.fieldMetadataUniversalIdentifier),
        ...(config.filters ?? []).map((f) => f.fieldMetadataUniversalIdentifier),
        ...(config.sorts ?? []).map((f) => f.fieldMetadataUniversalIdentifier),
      ].filter((id): id is string => id !== undefined);

      for (const id of referenced) {
        expect(objectFieldIds.has(id), `${file} references ${id}`).toBe(true);
      }
    }
  });

  it('groups the openings board by status with empty groups hidden', async () => {
    const views = await loadEntities<{
      type: string;
      shouldHideEmptyGroups?: boolean;
      mainGroupByFieldMetadataUniversalIdentifier?: string;
      groups?: { fieldValue: string }[];
    }>('views');
    const board = views.find((v) => v.config.type === 'KANBAN')?.config;

    expect(board?.mainGroupByFieldMetadataUniversalIdentifier).toBe(IDS.FIELD_IDS.opening.status);
    expect(board?.shouldHideEmptyGroups).toBe(true);
    expect(board?.groups?.map((g) => g.fieldValue)).toEqual(OPENING_STATUS_OPTIONS.map((o) => o.value));
  });

  it('puts Today at the top and every object item under one Job hunt section', async () => {
    const items = await loadEntities<{
      universalIdentifier: string;
      type: string;
      name?: string;
      parentUniversalIdentifier?: string;
      targetObjectUniversalIdentifier?: string;
      pageLayoutUniversalIdentifier?: string;
    }>('navigation-menu-items');
    const layouts = await loadEntities<{ universalIdentifier: string }>('page-layouts');
    const sections = items.filter((i) => i.config.type === 'SECTION');

    expect(sections).toHaveLength(1);
    expect(sections[0].config.name).toBe('Job hunt');
    for (const { file, config } of items) {
      if (config.type === 'SECTION') {
        continue;
      }
      expect(config.parentUniversalIdentifier, file).toBe(
        config.type === 'PAGE_LAYOUT' ? undefined : NAVIGATION_IDS.section,
      );
      if (config.type === 'OBJECT') {
        // App objects, plus the standard company, person and task the suite uses.
        const standard = ['company', 'person', 'task'].map(
          (k) => STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[k as 'company' | 'person' | 'task'].universalIdentifier,
        );
        expect([...Object.values(OBJECT_IDS), ...standard], file).toContain(config.targetObjectUniversalIdentifier);
      } else {
        expect(config.type, file).toBe('PAGE_LAYOUT');
        expect(layouts.map((l) => l.config.universalIdentifier)).toContain(
          config.pageLayoutUniversalIdentifier,
        );
      }
    }
    expect(items.filter((i) => i.config.type === 'OBJECT')).toHaveLength(10);
  });

  it('hosts the Today front component on a standalone page', async () => {
    const [layout] = await loadEntities<{
      type: string;
      tabs: { widgets: { configuration: { frontComponentUniversalIdentifier?: string } }[] }[];
    }>('page-layouts');

    expect(layout.config.type).toBe('STANDALONE_PAGE');
    expect(layout.config.tabs[0].widgets[0].configuration.frontComponentUniversalIdentifier).toBe(
      TODAY_IDS.frontComponent,
    );
    expect(readFileSync(path.join(SRC, 'front-components', 'today.front-component.tsx'), 'utf8')).toContain(
      'TODAY_IDS.frontComponent',
    );
  });
});

describe('buttons', () => {
  it('pins one command per button, pointing at its own front component', async () => {
    const commands = await loadEntities<{
      universalIdentifier: string;
      frontComponentUniversalIdentifier: string;
      isPinned?: boolean;
      availabilityType?: string;
      availabilityObjectUniversalIdentifier?: string;
      conditionalAvailabilityExpression?: string;
      label: string;
    }>('command-menu-items');
    const keys = Object.keys(BUTTONS) as ButtonKey[];

    expect(commands).toHaveLength(keys.length);
    for (const key of keys) {
      const spec = BUTTONS[key];
      const command = commands.find(
        (c) => c.config.universalIdentifier === BUTTON_IDS[key].commandMenuItem,
      )?.config;

      expect(command, key).toBeDefined();
      expect(command?.frontComponentUniversalIdentifier).toBe(BUTTON_IDS[key].frontComponent);
      expect(command?.isPinned).toBe(false);
      expect(command?.label).toBe(spec.label);
      if ('availability' in spec) {
        expect(command?.availabilityType).toBe('RECORD_SELECTION');
        expect(command?.availabilityObjectUniversalIdentifier).toBe(
          OBJECT_IDS[spec.target as 'opening' | 'proposal' | 'resumeVersion'],
        );
        expect(command?.conditionalAvailabilityExpression).toBe(
          buildAvailabilityExpression(spec.availability.field, spec.availability.values),
        );
      } else {
        expect(command?.availabilityType).toBe('GLOBAL');
      }

      const kebab = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const component = readFileSync(
        path.join(SRC, 'front-components', `${kebab}.front-component.tsx`),
        'utf8',
      );

      expect(component).toContain(`BUTTON_IDS.${key}.frontComponent`);
      expect(component.includes('isHeadless: true')).toBe(spec.mode === 'headless');
    }
  });

  it('offers only buttons that write one known decision type each', () => {
    const known = DECISION_TYPE_OPTIONS.map((o) => o.value) as string[];

    for (const [key, spec] of Object.entries(BUTTONS)) {
      expect(spec.decisionTypes.length, key).toBeGreaterThan(0);
      for (const type of spec.decisionTypes) {
        expect(known).toContain(type);
      }
      if (key !== 'openingOutcome') {
        expect(spec.decisionTypes, key).toHaveLength(1);
      }
    }
  });

  it('only shows opening buttons for statuses the harness has', () => {
    const statuses = OPENING_STATUS_OPTIONS.map((o) => o.value) as string[];

    for (const spec of Object.values(BUTTONS)) {
      if ('availability' in spec && spec.availability.field === 'status' && spec.target === 'opening') {
        for (const value of spec.availability.values) {
          expect(statuses).toContain(value);
        }
      }
    }
  });
});
