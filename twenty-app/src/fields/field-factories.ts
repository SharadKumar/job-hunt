import {
  type defineField,
  type defineObject,
  FieldType,
  OnDeleteAction,
  RelationType,
} from 'twenty-sdk/define';

// Small builders so object files read as a field list. Each returns a plain
// field manifest; the object or defineField call supplies the rest.

type ObjectField = Parameters<typeof defineObject>[0]['fields'][number];
type StandaloneField = Parameters<typeof defineField>[0];

type Base = {
  universalIdentifier: string;
  name: string;
  label: string;
  icon?: string;
  description?: string;
};

export type SelectOption = { value: string; label: string; color: string };

export const textField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.TEXT,
});

export const numberField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.NUMBER,
});

export const booleanField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.BOOLEAN,
  defaultValue: false,
});

export const dateField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.DATE,
});

export const dateTimeField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.DATE_TIME,
});

export const currencyField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.CURRENCY,
});

export const linksField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.LINKS,
});

export const richTextField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.RICH_TEXT,
});

export const rawJsonField = (base: Base): ObjectField => ({
  ...base,
  type: FieldType.RAW_JSON,
});

export const selectField = (
  base: Base & { options: readonly SelectOption[]; defaultValue?: string },
): ObjectField => {
  const { options, defaultValue, ...rest } = base;

  return {
    ...rest,
    type: FieldType.SELECT,
    options: options.map((option, position) => ({
      position,
      value: option.value,
      label: option.label,
      color: option.color as never,
    })),
    ...(defaultValue === undefined
      ? {}
      : { defaultValue: `'${defaultValue}'` }),
  } as ObjectField;
};

type RelationBase = Base & {
  targetObject: string;
  targetField: string;
};

// The side that holds the foreign key (`<name>Id`).
export const manyToOneField = (
  base: RelationBase & { onDelete?: OnDeleteAction },
): ObjectField => {
  const { targetObject, targetField, onDelete, ...rest } = base;

  return {
    ...rest,
    type: FieldType.RELATION,
    relationTargetObjectMetadataUniversalIdentifier: targetObject,
    relationTargetFieldMetadataUniversalIdentifier: targetField,
    universalSettings: {
      relationType: RelationType.MANY_TO_ONE,
      onDelete: onDelete ?? OnDeleteAction.SET_NULL,
      joinColumnName: `${rest.name}Id`,
    },
  } as ObjectField;
};

// The reverse side, listing the records that point here.
export const oneToManyField = (base: RelationBase): ObjectField => {
  const { targetObject, targetField, ...rest } = base;

  return {
    ...rest,
    type: FieldType.RELATION,
    relationTargetObjectMetadataUniversalIdentifier: targetObject,
    relationTargetFieldMetadataUniversalIdentifier: targetField,
    universalSettings: { relationType: RelationType.ONE_TO_MANY },
  } as ObjectField;
};

// A field added to a standard object (company, person) with defineField.
export const onStandardObject = (
  objectUniversalIdentifier: string,
  field: ObjectField,
): StandaloneField => ({ ...field, objectUniversalIdentifier }) as StandaloneField;
