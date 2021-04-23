import * as tsgql from '@ts-gql/schema';
import {
  types,
  FindManyArgsValue,
  ItemRootValue,
  KeystoneContext,
  TypesForList,
  FieldTypeFunc,
  getGqlNames,
  NextFieldType,
  CacheHint,
  FieldReadAccessArgs,
  IndividualFieldAccessControl,
  FieldAccessControl,
  FieldCreateAccessArgs,
  FieldUpdateAccessArgs,
  BaseGeneratedListTypes,
  CreateAccessControl,
  DeleteListAccessControl,
  ReadListAccessControl,
  UpdateListAccessControl,
  ListAccessControl,
  ListInfo,
} from '@keystone-next/types';
// import { runInputResolvers } from './input-resolvers';
import { validateFieldAccessControl } from '../createAccessControlContext';
import { getPrismaModelForList, IdType } from './utils';
import {
  getDBFieldPathForFieldOnMultiField,
  ResolvedDBField,
  ResolvedRelationDBField,
  resolveRelationships,
} from './prisma-schema';
import { throwAccessDenied } from './ListTypes/graphqlErrors';
import { InputResolvers, resolveWhereInput } from './input-resolvers';

const sortDirectionEnum = types.enum({
  name: 'SortDirection',
  values: types.enumValues(['asc', 'desc']),
});

type ListForListTypes = {
  fields: Record<string, FieldTypeFunc>;
  access?: ListAccessControl<BaseGeneratedListTypes>;
  singularGraphQLName: string;
  pluralGraphQLName: string;
};

export type InitialisedField = Omit<NextFieldType, 'dbField' | 'access'> & {
  dbField: ResolvedDBField;
  access: ResolvedFieldAccessControl;
};

type ResolvedListAccessControl = {
  read: ReadListAccessControl<BaseGeneratedListTypes>;
  create: CreateAccessControl<BaseGeneratedListTypes>;
  update: UpdateListAccessControl<BaseGeneratedListTypes>;
  delete: DeleteListAccessControl<BaseGeneratedListTypes>;
};

export type InitialisedList = {
  fields: Record<string, InitialisedField>;
  singularGraphQLName: string;
  pluralGraphQLName: string;
  types: TypesForList;
  access: ResolvedListAccessControl;
  inputResolvers: InputResolvers;
};

function getRelationVal(
  dbField: ResolvedRelationDBField,
  id: IdType,
  listKey: string,
  key: string,
  context: KeystoneContext
) {
  return dbField.mode === 'many'
    ? {
        findMany: async ({ first, skip, sortBy }: FindManyArgsValue) => {
          return getPrismaModelForList(context.prisma, dbField.list).findMany({
            where: {
              AND: [
                {
                  [dbField.field]: { id },
                },
                //   await runInputResolvers(
                //     typesForLists,
                //     lists,
                //     listKey,
                //     'where',
                //     where || {}
                //   ),
              ],
            },
            // TODO: needs to have input resolvers
            orderBy: sortBy,
            take: first ?? undefined,
            skip,
          });
        },
        count: async ({ first, skip, sortBy }: FindManyArgsValue) => {
          return getPrismaModelForList(context.prisma, dbField.list).count({
            where: {
              AND: [
                {
                  [dbField.field]: { id },
                },
                //   await runInputResolvers(
                //     typesForLists,
                //     lists,
                //     listKey,
                //     'where',
                //     where || {}
                //   ),
              ],
            },
            // TODO: needs to have input resolvers
            orderBy: sortBy,
            take: first ?? undefined,
            skip,
          });
        },
      }
    : async () => {
        return (
          await getPrismaModelForList(context.prisma, listKey).findUnique({
            where: {
              id,
            },
            select: { [key]: true },
          })
        )?.[key];
      };
}

function getValueForDBField(
  rootVal: ItemRootValue,
  dbField: ResolvedDBField,
  id: IdType,
  listKey: string,
  fieldPath: string,
  context: KeystoneContext
) {
  if (dbField.kind === 'multi') {
    return Object.fromEntries(
      Object.keys(dbField.fields).map(innerDBFieldKey => {
        const keyOnDbValue = getDBFieldPathForFieldOnMultiField(fieldPath, innerDBFieldKey);
        return [innerDBFieldKey, rootVal[keyOnDbValue] as any];
      })
    );
  }
  if (dbField.kind === 'relation') {
    return getRelationVal(dbField, id, listKey, fieldPath, context);
  }
  return rootVal[fieldPath] as any;
}

function outputTypeField(
  output: NextFieldType['output'],
  dbField: ResolvedDBField,
  cacheHint: CacheHint | undefined,
  access: IndividualFieldAccessControl<FieldReadAccessArgs>,
  listKey: string,
  fieldPath: string
) {
  return types.field<ItemRootValue, any, any, string, KeystoneContext>({
    type: output.type,
    deprecationReason: output.deprecationReason,
    description: output.description,
    args: output.args,
    extensions: output.extensions,
    async resolve(rootVal, args, context, info) {
      const id = (rootVal as any).id as IdType;

      // Check access
      const canAccess = await validateFieldAccessControl({
        access,
        args: {
          context,
          fieldKey: fieldPath,
          item: rootVal,
          listKey,
          operation: 'read',
          session: context.session,
        },
      });
      if (!canAccess) {
        // If the client handles errors correctly, it should be able to
        // receive partial data (for the fields the user has access to),
        // and then an `errors` array of AccessDeniedError's
        throwAccessDenied('query', fieldPath, { itemId: rootVal.id });
      }

      // Only static cache hints are supported at the field level until a use-case makes it clear what parameters a dynamic hint would take
      if (cacheHint && info && info.cacheControl) {
        info.cacheControl.setCacheHint(cacheHint as any);
      }

      const value = getValueForDBField(rootVal, dbField, id, listKey, fieldPath, context);

      if (output.resolve) {
        return output.resolve({ id, value, item: rootVal }, args, context, info);
      }
      return value;
    },
  });
}

function assertNoConflictingExtraOutputFields(
  listKey: string,
  fields: Record<string, InitialisedField>
) {
  const fieldPaths = new Set(Object.keys(fields));
  const alreadyFoundFields: Record<string, string> = {};
  for (const [fieldPath, field] of Object.entries(fields)) {
    if (field.extraOutputFields) {
      for (const outputTypeFieldName of Object.keys(field.extraOutputFields)) {
        // note that this and the case handled below are fundamentally the same thing but i want different errors for each of them
        if (fieldPaths.has(outputTypeFieldName)) {
          throw new Error(
            `The field ${fieldPath} on the ${listKey} list defines an extra GraphQL output field named ${outputTypeFieldName} which conflicts with the Keystone field type named ${outputTypeFieldName} on the same list`
          );
        }
        const alreadyFoundField = alreadyFoundFields[outputTypeFieldName];
        if (alreadyFoundField !== undefined) {
          throw new Error(
            `The field ${fieldPath} on the ${listKey} list defines an extra GraphQL output field named ${outputTypeFieldName} which conflicts with the Keystone field type named ${alreadyFoundField} which also defines an extra GraphQL output field named ${outputTypeFieldName}`
          );
        }
        alreadyFoundFields[outputTypeFieldName] = fieldPath;
      }
    }
  }
}

function assertIdFieldGraphQLTypesCorrect(
  listKey: string,
  fields: Record<string, InitialisedField>
) {
  const idField = fields.id;
  if (idField.input?.uniqueWhere === undefined) {
    throw new Error(
      `The idField on a list must define a uniqueWhere GraphQL input with the ID GraphQL scalar type but the idField for ${listKey} does not define one`
    );
  }
  if (idField.input.uniqueWhere.arg.type !== types.ID) {
    throw new Error(
      `The idField on a list must define a uniqueWhere GraphQL input with the ID GraphQL scalar type but the idField for ${listKey} defines the type ${idField.input.uniqueWhere.arg.type.graphQLType.toString()}`
    );
  }
  // we may want to loosen these constraints in the future
  if (idField.input.create !== undefined) {
    throw new Error(
      `The idField on a list must not define a create GraphQL input but the idField for ${listKey} does define one`
    );
  }
  if (idField.input.update !== undefined) {
    throw new Error(
      `The idField on a list must not define an update GraphQL input but the idField for ${listKey} does define one`
    );
  }
}

type ResolvedFieldAccessControl = {
  read: IndividualFieldAccessControl<FieldReadAccessArgs>;
  create: IndividualFieldAccessControl<FieldCreateAccessArgs>;
  update: IndividualFieldAccessControl<FieldUpdateAccessArgs>;
};

function parseFieldAccessControl(
  access: FieldAccessControl<BaseGeneratedListTypes> | undefined
): ResolvedFieldAccessControl {
  if (typeof access === 'boolean' || typeof access === 'function') {
    return { create: access, read: access, update: access };
  }
  // note i'm intentionally not using spread here because typescript can't express an optional property which cannot be undefined so spreading would mean there is a possibility that someone could pass {access: undefined} or {access:{read: undefined}} and bad things would happen
  return {
    create: access?.create ?? true,
    read: access?.read ?? true,
    update: access?.update ?? true,
  };
}

function parseListAccessControl(
  access: ListAccessControl<BaseGeneratedListTypes> | undefined
): ResolvedListAccessControl {
  if (typeof access === 'boolean' || typeof access === 'function') {
    return { create: access, read: access, update: access, delete: access };
  }
  // note i'm intentionally not using spread here because typescript can't express an optional property which cannot be undefined so spreading would mean there is a possibility that someone could pass {access: undefined} or {access:{read: undefined}} and bad things would happen
  return {
    create: access?.create ?? true,
    read: access?.read ?? true,
    update: access?.update ?? true,
    delete: access?.delete ?? true,
  };
}

export function initialiseLists(
  lists: Record<string, ListForListTypes>
): Record<string, InitialisedList> {
  const listInfos: Record<string, ListInfo> = {};

  const listsWithInitialisedFields = Object.fromEntries(
    Object.entries(lists).map(([listKey, { fields, ...list }]) => [
      listKey,
      {
        fields: Object.fromEntries(
          Object.entries(fields).map(([fieldPath, fieldFunc]) => [
            fieldPath,
            fieldFunc({ fieldPath, listKey, lists: listInfos }),
          ])
        ),
        ...list,
      },
    ])
  );

  const resolvedLists = resolveRelationships(
    Object.fromEntries(
      Object.entries(listsWithInitialisedFields).map(([listKey, field]) => [
        listKey,
        {
          fields: Object.fromEntries(
            Object.entries(field.fields).map(([fieldPath, { dbField }]) => [fieldPath, dbField])
          ),
        },
      ])
    )
  );

  const listsWithInitialisedFieldsAndResolvedDbFields = Object.fromEntries(
    Object.entries(listsWithInitialisedFields).map(([listKey, list]) => [
      listKey,
      {
        ...list,
        access: parseListAccessControl(list.access),
        fields: Object.fromEntries(
          Object.entries(list.fields).map(([fieldKey, field]) => {
            const access = parseFieldAccessControl(field.access);
            return [
              fieldKey,
              { ...field, access, dbField: resolvedLists[listKey].fields[fieldKey] },
            ];
          })
        ),
      },
    ])
  );

  for (const [listKey, { fields, ...list }] of Object.entries(
    listsWithInitialisedFieldsAndResolvedDbFields
  )) {
    const names = getGqlNames({
      listKey,
      pluralGraphQLName: list.pluralGraphQLName,
      singularGraphQLName: list.singularGraphQLName,
    });

    assertNoConflictingExtraOutputFields(listKey, fields);
    assertIdFieldGraphQLTypesCorrect(listKey, fields);
    let output = types.object<ItemRootValue>()({
      name: names.outputTypeName,
      fields: () => ({
        ...Object.fromEntries(
          Object.entries(fields).flatMap(([fieldPath, field]) =>
            [
              [fieldPath, field.output] as const,
              ...Object.entries(field.extraOutputFields || {}),
            ].map(([outputTypeFieldName, outputField]) => {
              return [
                outputTypeFieldName,
                outputTypeField(
                  outputField,
                  field.dbField,
                  field.cacheHint,
                  field.access.read,
                  listKey,
                  fieldPath
                ),
              ];
            })
          )
        ),
      }),
    });
    const uniqueWhere = types.inputObject({
      name: names.whereUniqueInputName,
      fields: {
        id: types.arg({
          type: types.ID,
        }),
      },
      //   fields: fromEntriesButTypedWell(
      //     Object.entries(fields)
      //       .map(
      //         ([key, field]) =>
      //           [
      //             key,
      //             field.dbField.kind === 'scalar' && field.dbField.index === 'unique' ||
      //               ? types.arg({
      //                   type:
      //                     // i don't like this conditional
      //                     // fields should define their uniqueWhere
      //                     key === 'id'
      //                       ? types.ID
      //                       : prismaScalarsToGraphQLScalars[field.dbField.scalar],
      //                 })
      //               : false,
      //           ] as const
      //       )
      //       .filter((x): x is [string, Exclude<typeof x[1], false>] => x[1] !== false)
      //   ),
    });
    // TODO: validate no fields are named AND, NOT, or OR
    const where: TypesForList['where'] = types.inputObject({
      name: names.whereInputName,
      fields: () => {
        return {
          AND: types.arg({
            type: types.list(types.nonNull(where)),
          }),
          OR: types.arg({
            type: types.list(types.nonNull(where)),
          }),
          NOT: types.arg({
            type: types.list(types.nonNull(where)),
          }),
          ...Object.fromEntries(
            Object.entries(fields)
              .map(([key, val]) => {
                return [key, val.input?.where?.arg] as const;
              })
              .filter(x => !!x[1])
          ),
        };
      },
    });

    const create = types.inputObject({
      name: names.createInputName,
      fields: () =>
        Object.fromEntries(
          Object.entries(fields)
            .map(([key, field]) => [key, field.input?.create?.arg] as const)
            .filter((x): x is [typeof x[0], NonNullable<typeof x[1]>] => x[1] != null)
        ),
    });

    const update = types.inputObject({
      name: names.updateInputName,
      fields: () =>
        Object.fromEntries(
          Object.entries(fields)
            .map(([key, field]) => [key, field.input?.update?.arg] as const)
            .filter((x): x is [typeof x[0], NonNullable<typeof x[1]>] => x[1] != null)
        ),
    });

    const sortBy = types.inputObject({
      name: names.listSortName,
      fields: Object.fromEntries(
        Object.entries(fields).flatMap(([key, { dbField }]): [string, tsgql.Arg<any, any>][] => {
          // note the conditions are intentionally checking that the db field is not a db field that doesn't support ordering
          // so that there will be a TS error if a new DBField type is added that doesn't support ordering
          // and when a new DBField type that does support ordering is added, it will just work
          if (
            dbField.kind !== 'none' &&
            dbField.kind !== 'relation' &&
            dbField.kind !== 'multi' &&
            dbField.isOrderable
          ) {
            return [[key, types.arg({ type: sortDirectionEnum })]];
          }

          // TODO: given multi db fields, maybe fields will want to customise this so the sort by type(and a resolver) should be a thing on field types?
          // (also probs useful bc of soon to be released filtering by relations in prisma)
          if (dbField.kind === 'multi') {
            let fields = Object.fromEntries(
              Object.entries(dbField.fields).flatMap(([key, dbField]) => {
                if (dbField.kind !== 'enum' && dbField.isOrderable) {
                  return [[key, types.arg({ type: sortDirectionEnum })]];
                }
                return [];
              })
            );
            if (fields.length) {
              return [
                [
                  key,
                  types.arg({
                    type: types.inputObject({
                      name: `${listKey}_${key}SortBy`,
                      fields,
                    }),
                  }),
                ],
              ];
            }
          }
          return [];
        })
      ),
    });

    const inputResolvers: InputResolvers = {
      where: input => resolveWhereInput(input, fields),
      uniqueWhere: async input => {
        const inputKeys = Object.keys(input);
        if (inputKeys.length !== 1) {
          throw new Error(
            `Exactly one key must be passed in a unique where input but ${inputKeys.length} keys were passed`
          );
        }
        const key = inputKeys[0];
        const val = input[key];
        const resolver = fields[key].input!.uniqueWhere!.resolve;
        const resolvedVal = resolver ? await resolver(val) : val;
        return {
          [key]: resolvedVal,
        };
      },
    };

    listInfos[listKey] = {
      inputResolvers,
      types: {
        output,
        uniqueWhere,
        where,
        create,
        sortBy,
        update,
      },
    };
  }

  return Object.fromEntries(
    Object.entries(listsWithInitialisedFieldsAndResolvedDbFields).map(([listKey, list]) => [
      listKey,
      { ...list, ...listInfos[listKey] },
    ])
  );
}