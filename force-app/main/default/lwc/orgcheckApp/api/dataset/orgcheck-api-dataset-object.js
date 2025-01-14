import { OrgCheckDataset } from '../core/orgcheck-api-dataset';
import { OrgCheckProcessor } from '../core/orgcheck-api-processing';
import { SFDC_Object } from '../data/orgcheck-api-data-object';
import { SFDC_Field } from '../data/orgcheck-api-data-field';
import { SFDC_FieldSet } from '../data/orgcheck-api-data-fieldset';
import { SFDC_PageLayout } from '../data/orgcheck-api-data-pagelayout';
import { SFDC_Limit } from '../data/orgcheck-api-data-limit';
import { SFDC_ValidationRule } from '../data/orgcheck-api-data-validationrule';
import { SFDC_WebLink } from '../data/orgcheck-api-data-weblink';
import { SFDC_RecordType } from '../data/orgcheck-api-data-recordtype';
import { SFDC_ObjectRelationShip } from '../data/orgcheck-api-data-objectrelationship';

export class OrgCheckDatasetObject extends OrgCheckDataset {

    async run(sfdcManager, dataFactory, localLogger, parameters) {

        // Init the factories
        const fieldDataFactory = dataFactory.getInstance(SFDC_Field);
        const fieldSetDataFactory = dataFactory.getInstance(SFDC_FieldSet);
        const layoutDataFactory = dataFactory.getInstance(SFDC_PageLayout);
        const limitDataFactory = dataFactory.getInstance(SFDC_Limit);
        const validationRuleDataFactory = dataFactory.getInstance(SFDC_ValidationRule);
        const webLinkDataFactory = dataFactory.getInstance(SFDC_WebLink);
        const recordTypeDataFactory = dataFactory.getInstance(SFDC_RecordType);
        const relationshipDataFactory = dataFactory.getInstance(SFDC_ObjectRelationShip);
        const objectDataFactory = dataFactory.getInstance(SFDC_Object);

        const fullObjectApiName = parameters.get('object');
        const splittedApiName = fullObjectApiName.split('__');
        const packageName = splittedApiName.length === 3 ? splittedApiName[0] : '';
        
        const results = await Promise.all([
            sfdcManager.describe(fullObjectApiName),
            sfdcManager.soqlQuery([{ 
                queryMore: false, // we should have only one record max so no need to have queryMore activated.
                tooling: true, // We need the tooling to get the Description, ApexTriggers, FieldSets, ... which are not accessible from REST API)
                string: 'SELECT Id, DurableId, DeveloperName, Description, NamespacePrefix, ExternalSharingModel, InternalSharingModel, '+
                            '(SELECT DurableId, QualifiedApiName, Description, IsIndexed FROM Fields), '+
                            '(SELECT Id FROM ApexTriggers), '+
                            '(SELECT Id, MasterLabel, Description FROM FieldSets), '+
                            '(SELECT Id, Name, LayoutType FROM Layouts), '+
                            '(SELECT DurableId, Label, Max, Remaining, Type FROM Limits), '+
                            '(SELECT Id, Active, Description, ErrorDisplayField, ErrorMessage, '+
                                'ValidationName FROM ValidationRules), '+
                            '(SELECT Id, Name FROM WebLinks) '+
                        'FROM EntityDefinition '+
                        `WHERE QualifiedApiName = '${fullObjectApiName}' `+
                        (!packageName ? `AND PublisherId IN ('System', '<local>')` : `AND NamespacePrefix = '${packageName}' `)
            }]),
            sfdcManager.recordCount(fullObjectApiName)
        ]);

        // the first promise was describe
        // so we initialize the object with the first result
        const sobjectDescribed = results[0]; 
        const sobjectType = sfdcManager.getObjectType(sobjectDescribed.name, sobjectDescribed.customSetting);

        // the second promise was the soql query on EntityDefinition
        // so we get the record of that query and map it to the previous object.
        const entity = results[1][0].records[0];
        if (!entity) { // If that entity was not found in the tooling API
            throw new TypeError(`No entity definition record found for: ${fullObjectApiName}`)
        }
                
        // the third promise is the number of records!!
        const recordCount = results[2]; 

        // fields (standard and custom)
        const customFieldIds = []; 
        const standardFieldsMapper = new Map();
        await OrgCheckProcessor.chaque(entity.Fields?.records, (f) => {
            if (f.DurableId && f.DurableId.split && f.DurableId.includes) {
                const id = sfdcManager.caseSafeId(f.DurableId.split('.')[1]);
                if (f.DurableId.includes('.00N')) {
                    customFieldIds.push(id);
                } else {
                    standardFieldsMapper.set(f.QualifiedApiName, { 
                        id: id,
                        description: f.Description,
                        isIndexed: f.IsIndexed
                    });
                }
            }
        });
        const standardFields = await OrgCheckProcessor.carte(
            await OrgCheckProcessor.filtre(sobjectDescribed.fields, (field) => standardFieldsMapper.has(field.name)),
            (field) => {
                const fieldMapper = standardFieldsMapper.get(field.name);
                return fieldDataFactory.createWithScore({
                    id: fieldMapper.id,
                    name: field.label, 
                    label: field.label, 
                    description: fieldMapper.description,
                    tooltip: field.inlineHelpText,
                    type: field.type,
                    length: field.length,
                    isUnique: field.unique,
                    isEncrypted: field.encrypted,
                    isExternalId: field.externalId,
                    isIndexed: fieldMapper.isIndexed,
                    defaultValue: field.defaultValue,
                    formula: field.calculatedFormula,
                    url: sfdcManager.setupUrl('field', fieldMapper.id, entity.DurableId, sobjectType)
                });
            }
        );

        // apex triggers
        const apexTriggerIds = await OrgCheckProcessor.carte(
            entity.ApexTriggers?.records, 
            (t) => sfdcManager.caseSafeId(t.Id)
        );

        // field sets
        const fieldSets = await OrgCheckProcessor.carte(
            entity.FieldSets?.records,
            (t) => fieldSetDataFactory.createWithScore({ 
                id: sfdcManager.caseSafeId(t.Id), 
                label: t.MasterLabel, 
                description: t.Description,
                url: sfdcManager.setupUrl('field-set', t.Id, entity.DurableId) 
            })
        );

        // page layouts
        const layouts = await OrgCheckProcessor.carte(
            entity.Layouts?.records,
            (t) => layoutDataFactory.createWithScore({ 
                id: sfdcManager.caseSafeId(t.Id), 
                name: t.Name, 
                url: sfdcManager.setupUrl('layout', t.Id, entity.DurableId), 
                type: t.LayoutType 
            })
        );
        
        // limits
        const limits = await OrgCheckProcessor.carte(
            entity.Limits?.records,
            (t) => limitDataFactory.createWithScore({ 
                id: sfdcManager.caseSafeId(t.DurableId), 
                label: t.Label, 
                max: t.Max, 
                remaining: t.Remaining, 
                used: (t.Max-t.Remaining), 
                usedPercentage: ((t.Max-t.Remaining)/t.Max),
                type: t.Type 
            })
        );
        
        // validation rules
        const validationRules = await OrgCheckProcessor.carte(
            entity.ValidationRules?.records,
            (t) => validationRuleDataFactory.createWithScore({ 
                id: sfdcManager.caseSafeId(t.Id), 
                name: t.ValidationName, 
                isActive: t.Active,
                description: t.Description,
                errorDisplayField: t.ErrorDisplayField,
                errorMessage: t.ErrorMessage,
                url: sfdcManager.setupUrl('validation-rule', t.Id), 
            })
        );
        
        // weblinks and actions
        const webLinks = await OrgCheckProcessor.carte(
            entity.WebLinks?.records,
            (t) => webLinkDataFactory.createWithScore({ 
                id: sfdcManager.caseSafeId(t.Id), 
                name: t.Name, 
                url: sfdcManager.setupUrl('web-link', t.Id, entity.DurableId) 
            })
        );
        
        // record types
        const recordTypes = await OrgCheckProcessor.carte(
            sobjectDescribed.recordTypeInfos,
            (t) => recordTypeDataFactory.createWithScore({ 
                id: sfdcManager.caseSafeId(t.recordTypeId), 
                name: t.name, 
                developerName: t.developerName, 
                url: sfdcManager.setupUrl('record-type', t.recordTypeId, entity.DurableId),
                isActive: t.active,
                isAvailable: t.available,
                isDefaultRecordTypeMapping: t.defaultRecordTypeMapping,
                isMaster: t.master 
            })
        );
        
        // relationships
        const relationships = await OrgCheckProcessor.carte(
            await OrgCheckProcessor.filtre(sobjectDescribed.childRelationships, (relationship) => !relationship.relationshipName),
            (relationship) => relationshipDataFactory.createWithScore({ 
                name: relationship.relationshipName,
                childObject: relationship.childSObject,
                fieldName: relationship.field,
                isCascadeDelete: relationship.cascadeDelete,
                isRestrictedDelete: relationship.restrictedDelete
            })
        );

        const object = objectDataFactory.createWithScore({
            id: entity.DurableId,
            label: sobjectDescribed.label,
            labelPlural: sobjectDescribed.labelPlural,
            isCustom: sobjectDescribed.custom,
            isFeedEnabled: sobjectDescribed.feedEnabled,
            isMostRecentEnabled: sobjectDescribed.mruEnabled,
            isSearchable: sobjectDescribed.searchable,
            keyPrefix: sobjectDescribed.keyPrefix,
            name: entity.DeveloperName,
            apiname: sobjectDescribed.name,
            url: sfdcManager.setupUrl('object', '', entity.Id, sobjectType),
            package: (entity.NamespacePrefix || ''),
            typeId: sobjectType,
            description: entity.Description,
            externalSharingModel: entity.ExternalSharingModel,
            internalSharingModel: entity.InternalSharingModel,
            apexTriggerIds: apexTriggerIds,
            fieldSets: fieldSets,
            limits: limits,
            layouts: layouts,
            validationRules: validationRules,
            webLinks: webLinks,
            standardFields: standardFields,
            customFieldIds: customFieldIds,
            recordTypes: recordTypes,
            relationships: relationships,
            recordCount: recordCount
        });

        // Return data as object (and not as a map!!!)
        localLogger.log(`Done`);
        return object;
    } 
}