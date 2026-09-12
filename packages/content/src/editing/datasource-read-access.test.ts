/* eslint-disable no-unused-expressions, @typescript-eslint/no-unused-expressions */
import { expect } from 'chai';
import { LayoutServiceData } from '../layout';
import {
  buildDatasourceAccessQuery,
  chunkDatasourceIds,
  clearInaccessibleDatasourceFields,
  collectDatasourceIds,
  isDatasourceInaccessible,
} from './datasource-read-access';

const createLayout = (): LayoutServiceData => ({
  sitecore: {
    context: { pageEditing: true, language: 'en' },
    route: {
      name: 'home',
      placeholders: {
        main: [
          {
            uid: 'rte-1',
            componentName: 'RichText',
            dataSource: '/sitecore/content/site/Home/Data/RTE',
            isContentResolved: true,
            fields: {
              Text: {
                value: 'secret copy',
                metadata: { fieldId: 'text-field' },
              },
            },
            placeholders: {
              inner: [
                {
                  uid: 'nested-1',
                  componentName: 'RichText',
                  dataSource: '{NESTED-DS}',
                  isContentResolved: true,
                  fields: {
                    Text: { value: 'nested copy', metadata: { fieldId: 'nested-field' } },
                  },
                },
              ],
            },
          },
          {
            uid: 'allowed-1',
            componentName: 'RichText',
            dataSource: '/sitecore/content/site/Home/Data/Public',
            isContentResolved: true,
            fields: {
              Text: { value: 'public copy' },
            },
          },
          {
            uid: 'no-ds',
            componentName: 'Container',
            dataSource: '',
            fields: {},
          },
        ],
      },
    },
  },
});

describe('datasource-read-access', () => {
  describe('collectDatasourceIds', () => {
    it('should collect unique nested datasource ids and skip empty values', () => {
      const ids = collectDatasourceIds(createLayout());

      expect(ids).to.have.members([
        '/sitecore/content/site/Home/Data/RTE',
        '{NESTED-DS}',
        '/sitecore/content/site/Home/Data/Public',
      ]);
    });

    it('should return an empty list when the route is missing', () => {
      expect(
        collectDatasourceIds({
          sitecore: { context: {}, route: null },
        })
      ).to.deep.equal([]);
    });
  });

  describe('buildDatasourceAccessQuery', () => {
    it('should alias each datasource path as a language-scoped item lookup', () => {
      const { query, variables, aliases } = buildDatasourceAccessQuery([
        '/sitecore/content/a',
        '{GUID}',
      ]);

      expect(aliases).to.deep.equal(['ds0', 'ds1']);
      expect(variables).to.deep.equal({
        path0: '/sitecore/content/a',
        path1: '{GUID}',
      });
      expect(query).to.include('ds0: item(path: $path0, language: $language) { id rendered }');
      expect(query).to.include('ds1: item(path: $path1, language: $language) { id rendered }');
    });
  });

  describe('isDatasourceInaccessible', () => {
    it('should treat a missing item as inaccessible', () => {
      expect(isDatasourceInaccessible(null)).to.equal(true);
    });

    it('should treat a rendered route of null as inaccessible', () => {
      expect(
        isDatasourceInaccessible({
          id: 'guid',
          rendered: { sitecore: { route: null } },
        })
      ).to.equal(true);
    });

    it('should treat an item with a route as accessible', () => {
      expect(
        isDatasourceInaccessible({
          id: 'guid',
          rendered: { sitecore: { route: { name: 'RTE' } } },
        })
      ).to.equal(false);
    });
  });

  describe('chunkDatasourceIds', () => {
    it('should keep small lists in a single batch', () => {
      expect(chunkDatasourceIds(['a', 'b'])).to.deep.equal([['a', 'b']]);
    });
  });

  describe('clearInaccessibleDatasourceFields', () => {
    it('should empty field values and mark content unresolved for denied datasources only', () => {
      const layout = createLayout();

      clearInaccessibleDatasourceFields(
        layout,
        new Set(['/sitecore/content/site/Home/Data/RTE', '{NESTED-DS}'])
      );

      const [denied, allowed] = layout.sitecore.route?.placeholders.main || [];
      expect(denied.isContentResolved).to.equal(false);
      expect((denied.fields?.Text as { value: string; metadata?: { fieldId: string } }).value).to.equal(
        ''
      );
      expect(
        (denied.fields?.Text as { metadata?: { fieldId: string } }).metadata?.fieldId
      ).to.equal('text-field');

      const nested = denied.placeholders?.inner[0];
      expect(nested?.isContentResolved).to.equal(false);
      expect((nested?.fields?.Text as { value: string }).value).to.equal('');

      expect(allowed.isContentResolved).to.equal(true);
      expect((allowed.fields?.Text as { value: string }).value).to.equal('public copy');
    });
  });
});
