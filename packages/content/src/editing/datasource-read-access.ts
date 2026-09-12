import {
  ComponentFields,
  ComponentRendering,
  GenericFieldValue,
  LayoutServiceData,
  PlaceholdersData,
} from '../layout';

const DATASOURCE_ACCESS_BATCH_SIZE = 20;

/**
 * Collects unique datasource item paths/IDs from a layout tree.
 * @param {LayoutServiceData} layout editing layout data
 * @returns {string[]} unique non-empty datasource identifiers
 * @internal
 */
export const collectDatasourceIds = (layout: LayoutServiceData): string[] => {
  const ids = new Set<string>();
  const placeholders = layout.sitecore.route?.placeholders;
  if (placeholders) {
    collectFromPlaceholders(placeholders, ids);
  }
  return Array.from(ids);
};

const collectFromPlaceholders = (placeholders: PlaceholdersData, ids: Set<string>) => {
  Object.keys(placeholders).forEach((name) => {
    placeholders[name].forEach((rendering) => collectFromRendering(rendering, ids));
  });
};

const collectFromRendering = (rendering: ComponentRendering, ids: Set<string>) => {
  if (rendering.dataSource) {
    ids.add(rendering.dataSource);
  }

  if (rendering.placeholders) {
    collectFromPlaceholders(rendering.placeholders, ids);
  }

  const experiences = (rendering as ComponentRendering & {
    experiences?: Record<string, ComponentRendering>;
  }).experiences;
  if (experiences) {
    Object.values(experiences).forEach((experience) => collectFromRendering(experience, ids));
  }
};

/**
 * Builds a batched GraphQL query that checks whether the current user can read each item.
 * @param {string[]} datasourceIds datasource paths or IDs
 * @returns {{ query: string, variables: Record<string, string>, aliases: string[] }} query parts
 * @internal
 */
export const buildDatasourceAccessQuery = (datasourceIds: string[]) => {
  const variables: Record<string, string> = {};
  const selections = datasourceIds.map((id, index) => {
    const alias = `ds${index}`;
    const variable = `path${index}`;
    variables[variable] = id;
    return `${alias}: item(path: $${variable}, language: $language) { id rendered }`;
  });

  const variableDefs = [
    '$language: String!',
    ...datasourceIds.map((_, index) => `$path${index}: String!`),
  ].join(', ');

  return {
    query: `query DatasourceAccess(${variableDefs}) { ${selections.join(' ')} }`,
    variables,
    aliases: datasourceIds.map((_, index) => `ds${index}`),
  };
};

/**
 * Splits datasource IDs into request-sized batches.
 * @param {string[]} datasourceIds datasource paths or IDs
 * @returns {string[][]} batches
 * @internal
 */
export const chunkDatasourceIds = (datasourceIds: string[]): string[][] => {
  const batches: string[][] = [];
  for (let i = 0; i < datasourceIds.length; i += DATASOURCE_ACCESS_BATCH_SIZE) {
    batches.push(datasourceIds.slice(i, i + DATASOURCE_ACCESS_BATCH_SIZE));
  }
  return batches;
};

/**
 * Clears field values on renderings whose datasource the current user cannot read.
 * Field metadata is preserved so Pages chromes still attach.
 * @param {LayoutServiceData} layout editing layout data
 * @param {Set<string>} inaccessibleIds datasource paths/IDs the user cannot read
 * @returns {LayoutServiceData} the same layout instance with inaccessible fields cleared
 * @internal
 */
export const clearInaccessibleDatasourceFields = (
  layout: LayoutServiceData,
  inaccessibleIds: Set<string>
): LayoutServiceData => {
  const placeholders = layout.sitecore.route?.placeholders;
  if (placeholders && inaccessibleIds.size) {
    clearPlaceholders(placeholders, inaccessibleIds);
  }
  return layout;
};

const clearPlaceholders = (placeholders: PlaceholdersData, inaccessibleIds: Set<string>) => {
  Object.keys(placeholders).forEach((name) => {
    placeholders[name].forEach((rendering) => clearRendering(rendering, inaccessibleIds));
  });
};

const clearRendering = (rendering: ComponentRendering, inaccessibleIds: Set<string>) => {
  if (rendering.dataSource && inaccessibleIds.has(rendering.dataSource)) {
    rendering.isContentResolved = false;
    if (rendering.fields) {
      rendering.fields = clearFields(rendering.fields);
    }
  }

  if (rendering.placeholders) {
    clearPlaceholders(rendering.placeholders, inaccessibleIds);
  }

  const experiences = (rendering as ComponentRendering & {
    experiences?: Record<string, ComponentRendering>;
  }).experiences;
  if (experiences) {
    Object.values(experiences).forEach((experience) => clearRendering(experience, inaccessibleIds));
  }
};

const clearFields = (fields: ComponentFields): ComponentFields => {
  const cleared: ComponentFields = {};

  Object.keys(fields).forEach((name) => {
    cleared[name] = clearField(fields[name]);
  });

  return cleared;
};

const clearField = (field: ComponentFields[string]): ComponentFields[string] => {
  if (!field || typeof field !== 'object') {
    return field;
  }

  if (Array.isArray(field)) {
    return field.map((item) =>
      item && typeof item === 'object' && 'fields' in item && item.fields
        ? { ...item, fields: clearFields(item.fields as ComponentFields) }
        : item
    );
  }

  if ('fields' in field && field.fields && !('value' in field)) {
    return { ...field, fields: clearFields(field.fields as ComponentFields) };
  }

  if ('value' in field) {
    return {
      ...field,
      value: emptyFieldValue(field.value) as GenericFieldValue,
    };
  }

  return field;
};

const emptyFieldValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return [];
  }
  if (value && typeof value === 'object') {
    return {};
  }
  if (typeof value === 'boolean') {
    return false;
  }
  if (typeof value === 'number') {
    return 0;
  }
  return '';
};

/**
 * A datasource is inaccessible when GraphQL returns no item, or when Layout Service
 * returns the same empty route it uses for a page the user cannot read.
 * @param {object | null | undefined} item GraphQL item payload
 * @returns {boolean} whether the current user cannot read the item
 * @internal
 */
export const isDatasourceInaccessible = (
  item: { id?: string; rendered?: { sitecore?: { route?: unknown } } } | null | undefined
): boolean => {
  if (!item) {
    return true;
  }

  if (item.rendered?.sitecore && item.rendered.sitecore.route == null) {
    return true;
  }

  return false;
};
