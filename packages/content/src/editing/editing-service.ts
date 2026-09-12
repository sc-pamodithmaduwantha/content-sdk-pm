import {
  GraphQLClient,
  GraphQLRequestClientFactory,
  FetchOptions,
} from '@sitecore-content-sdk/core';
import debug from '../debug';
import { LayoutServiceData, LayoutServicePageState } from '../layout';
import { LayoutKind } from './models';
import { DEFAULT_VARIANT } from '../personalize';
import {
  buildDatasourceAccessQuery,
  chunkDatasourceIds,
  clearInaccessibleDatasourceFields,
  collectDatasourceIds,
  isDatasourceInaccessible,
} from './datasource-read-access';

/**
 * GraphQL query for fetching editing data.
 */
export const query = /* GraphQL */ `
  query EditingQuery($itemId: String!, $language: String!, $version: String) {
    item(path: $itemId, language: $language, version: $version) {
      rendered
    }
  }
`;

/**
 * Response from the GraphQL Editing query.
 */
export type GraphQLEditingQueryResponse = {
  item: { rendered: LayoutServiceData };
};

/**
 * Configuration for the EditingService
 * @public
 */
export interface EditingServiceConfig {
  /**
   * A GraphQL Request Client Factory is a function that accepts configuration and returns an instance of a GraphQLRequestClient.
   * This factory function is used to create and configure GraphQL clients for making GraphQL API requests.
   */
  clientFactory: GraphQLRequestClientFactory;
}

/**
 * Options for fetching editing data
 * @public
 */
export type EditingOptions = {
  itemId: string;
  language: string;
  version?: string;
  layoutKind?: LayoutKind;
  mode: Exclude<LayoutServicePageState, 'Normal'>;
  site?: string;
  variantId: string;
  previewTime?: string;
};

/**
 * Service for fetching editing data from Sitecore using the Sitecore's GraphQL API.
 * Expected to be used in XMCloud Pages preview (editing) Metadata Edit Mode.
 * @public
 */
export class EditingService {
  private graphQLClient: GraphQLClient;

  /**
   * Fetch layout data using the Sitecore GraphQL endpoint.
   * @param {EditingServiceConfig} serviceConfig configuration
   */
  constructor(public serviceConfig: EditingServiceConfig) {
    this.graphQLClient = this.getGraphQLClient();
  }

  /**
   * Fetches editing data. Provides the layout data and dictionary phrases
   * @param {object} variables - The parameters for fetching editing data.
   * @param {string} variables.itemId - The item id (path) to fetch layout data for.
   * @param {string} variables.language - The language to fetch layout data for.
   * @param {string} variables.mode - The editing mode to fetch layout data for.
   * @param {string} variables.variantId - The variant id to fetch layout data for.
   * @param {string} [variables.version] - The version of the item (optional).
   * @param {LayoutKind} [variables.layoutKind] - The final or shared layout variant.
   * @param {string} [variables.site] - The site context for fetching layout data (optional).
   * @param {string} [variables.previewTime] - The preview time for time-based preview (optional).
   * @param {FetchOptions} [fetchOptions] Options to override graphQL client details like retries and fetch implementation
   * @returns {Promise} The layout data and dictionary phrases.
   */
  async fetchEditingData(
    {
      itemId,
      language,
      version,
      layoutKind = LayoutKind.Final,
      mode,
      site,
      variantId,
      previewTime,
    }: EditingOptions,
    fetchOptions?: FetchOptions
  ) {
    debug.editing('fetching editing data for %s %s %s %s', itemId, language, version, layoutKind);

    if (!language) {
      throw new RangeError('The language must be a non-empty string');
    }

    const editModeHeader = mode === 'edit' ? 'true' : 'false';
    const previewModeHeader = mode === 'preview' ? 'true' : 'false';

    const editingData = await this.graphQLClient.request<GraphQLEditingQueryResponse>(
      query,
      {
        itemId,
        version,
        language,
      },
      {
        ...fetchOptions,
        headers: {
          ...fetchOptions?.headers,
          sc_layoutKind: layoutKind,
          sc_editMode: editModeHeader,
          sc_previewMode: previewModeHeader,
          sc_variant: variantId === DEFAULT_VARIANT ? 'default' : variantId,
          ...(site && { sc_site: site }),
          ...(previewTime && { sc_previewTime: previewTime }),
        },
      }
    );

    const layoutData = editingData?.item?.rendered || {
      sitecore: {
        context: { pageEditing: true, language },
        route: null,
      },
    };

    await restrictInaccessibleDatasources(this.graphQLClient, layoutData, language, fetchOptions);

    return {
      layoutData,
    };
  }

  /**
   * Gets a GraphQL client that can make requests to the API.
   * @returns {GraphQLClient} implementation
   */
  protected getGraphQLClient(): GraphQLClient {
    if (!this.serviceConfig.clientFactory) {
      throw new Error('clientFactory needs to be provided when initializing GraphQL client.');
    }

    return this.serviceConfig.clientFactory({
      debugger: debug.editing,
    });
  }
}

/**
 * `item.rendered` in edit mode still serializes datasource field values even when the
 * current Pages user is denied Read. Recheck each datasource as that user (no sc_editMode)
 * and clear fields the user cannot read.
 * @param {GraphQLClient} graphQLClient GraphQL client used for the access check
 * @param {LayoutServiceData} layoutData editing layout data
 * @param {string} language item language
 * @param {FetchOptions} [fetchOptions] caller fetch options (must include Authorization)
 */
const restrictInaccessibleDatasources = async (
  graphQLClient: GraphQLClient,
  layoutData: LayoutServiceData,
  language: string,
  fetchOptions?: FetchOptions
): Promise<void> => {
  const authorization = fetchOptions?.headers?.Authorization || fetchOptions?.headers?.authorization;
  if (!authorization || !layoutData.sitecore.route) {
    debug.editing(
      'skipping datasource read-access check (authorization present: %s)',
      Boolean(authorization)
    );
    return;
  }

  const datasourceIds = collectDatasourceIds(layoutData);
  if (!datasourceIds.length) {
    return;
  }

  const inaccessibleIds = new Set<string>();

  try {
    for (const batch of chunkDatasourceIds(datasourceIds)) {
      const { query: accessQuery, variables, aliases } = buildDatasourceAccessQuery(batch);
      const result = await graphQLClient.request<
        Record<string, { id?: string; rendered?: { sitecore?: { route?: unknown } } } | null>
      >(
        accessQuery,
        { language, ...variables },
        {
          ...fetchOptions,
          headers: {
            ...fetchOptions?.headers,
            // Same identity as the page preview check: user token + edit-mode layout security
            sc_editMode: 'true',
          },
        }
      );

      aliases.forEach((alias, index) => {
        if (isDatasourceInaccessible(result?.[alias])) {
          inaccessibleIds.add(batch[index]);
        }
      });
    }
  } catch (error) {
    debug.editing('failed to verify datasource read access: %o', error);
    return;
  }

  if (inaccessibleIds.size) {
    debug.editing(
      'clearing fields for %d datasource(s) the current user cannot read',
      inaccessibleIds.size
    );
    clearInaccessibleDatasourceFields(layoutData, inaccessibleIds);
  }
};
