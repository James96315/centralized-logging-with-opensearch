/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License").
You may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import * as path from 'path';
import * as appsync from '@aws-cdk/aws-appsync-alpha';
import {
    NagSuppressions,
} from 'cdk-nag';
import {
    Aws,
    Duration,
    Fn,
    CfnCondition,
    RemovalPolicy,
    aws_dynamodb as ddb,
    aws_iam as iam,
    aws_lambda as lambda,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { SharedPythonLayer } from '../layer/layer';
import { addCfnNagSuppressRules } from '../main-stack';
import { SvcPipelineFlowStack } from './svc-pipeline-flow';
import { MicroBatchStack } from '../microbatch/main/services/amazon-services-stack';

export interface SvcPipelineStackProps {
    /**
     * Step Functions State Machine ARN for CloudFormation deployment Flow
     *
     * @default - None.
     */
    readonly cfnFlowSMArn: string;

    /**
     * Default Appsync GraphQL API for OpenSearch REST API Handler
     *
     * @default - None.
     */
    readonly graphqlApi: appsync.GraphqlApi;

    readonly microBatchStack: MicroBatchStack;


    readonly centralAssumeRolePolicy: iam.ManagedPolicy;
    readonly subAccountLinkTable: ddb.Table;
    readonly grafanaTable: ddb.Table;

    readonly solutionId: string;
    readonly stackPrefix: string;
}
export class SvcPipelineStack extends Construct {
    readonly svcPipelineTable: ddb.Table;

    constructor(scope: Construct, id: string, props: SvcPipelineStackProps) {
        super(scope, id);

        // Create a table to store logging pipeline info
        this.svcPipelineTable = new ddb.Table(this, 'SvcPipeline', {
            partitionKey: {
                name: 'id',
                type: ddb.AttributeType.STRING,
            },
            billingMode: ddb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.DESTROY,
            encryption: ddb.TableEncryption.DEFAULT,
            pointInTimeRecovery: true,
        });

        const cfnPipelineTable = this.svcPipelineTable.node
            .defaultChild as ddb.CfnTable;
        cfnPipelineTable.overrideLogicalId('SvcPipeline');
        addCfnNagSuppressRules(cfnPipelineTable, [
            {
                id: 'W73',
                reason: 'This table has billing mode as PROVISIONED',
            },
            {
                id: 'W74',
                reason:
                    'This table is set to use DEFAULT encryption, the key is owned by DDB.',
            },
        ]);

        // Create a Step Functions to orchestrate pipeline flow
        const pipeFlow = new SvcPipelineFlowStack(this, 'PipelineFlowSM', {
            tableArn: this.svcPipelineTable.tableArn,
            tableName: this.svcPipelineTable.tableName,
            cfnFlowSMArn: props.cfnFlowSMArn,
            pipelineResourcesBuilder: props.microBatchStack.microBatchLambdaStack.PipelineResourcesBuilderStack.PipelineResourcesBuilder,
            microBatchStack: props.microBatchStack,
        });

        // Create a lambda to handle all pipeline related APIs.
        const pipelineHandler = new lambda.Function(this, 'PipelineHandler', {
            code: lambda.AssetCode.fromAsset(
                path.join(__dirname, '../../lambda/api/pipeline')
            ),
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'lambda_function.lambda_handler',
            timeout: Duration.seconds(60),
            memorySize: 1024,
            layers: [SharedPythonLayer.getInstance(this)],
            environment: {
                STATE_MACHINE_ARN: pipeFlow.stateMachineArn,
                PIPELINE_TABLE: this.svcPipelineTable.tableName,
                PIPELINR_TABLE_ARN: this.svcPipelineTable.tableArn,
                GRAFANA_TABLE: props.grafanaTable.tableName,
                META_TABLE: props.microBatchStack.microBatchDDBStack.MetaTable.tableName,
                ETLLOG_TABLE: props.microBatchStack.microBatchDDBStack.ETLLogTable.tableName,
                STACK_PREFIX: props.stackPrefix,
                SOLUTION_VERSION: process.env.VERSION || 'v1.0.0',
                SOLUTION_ID: props.solutionId,
                SUB_ACCOUNT_LINK_TABLE_NAME: props.subAccountLinkTable.tableName,
                ACCOUNT_ID: Aws.ACCOUNT_ID,
                REGION: Aws.REGION,
                PARTITION: Aws.PARTITION,
            },
            description: `${Aws.STACK_NAME} - Pipeline APIs Resolver`,
        });

        // Grant permissions to the pipeline lambda
        this.svcPipelineTable.grantReadWriteData(pipelineHandler);
        props.subAccountLinkTable.grantReadData(pipelineHandler);
        props.grafanaTable.grantReadData(pipelineHandler);
        props.microBatchStack.microBatchDDBStack.ETLLogTable.grantReadData(pipelineHandler);

        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [pipeFlow.stateMachineArn],
                actions: ['states:StartExecution'],
            })
        );
        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: ['*'],
                actions: ['es:DescribeElasticsearchDomain', 'es:DescribeDomain'],
            })
        );

        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [props.microBatchStack.microBatchDDBStack.MetaTable.tableArn],
                actions: [
                    "dynamodb:GetItem",
                    "dynamodb:UpdateItem",
                ],
            })
        );

        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [props.microBatchStack.microBatchKMSStack.encryptionKey.keyArn],
                actions: [
                    "kms:GenerateDataKey*",
                    "kms:Decrypt",
                    "kms:Encrypt"
                ],
            })
        );
        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    "s3:GetBucketNotification",
                ],
                effect: iam.Effect.ALLOW,
                resources: [
                    `arn:${Aws.PARTITION}:s3:::*`,
                ],
            })
        );
        NagSuppressions.addResourceSuppressions(pipelineHandler, [
            {
                id: "AwsSolutions-IAM5",
                reason: "The managed policy needs to use any resources.",
            },
        ]);

        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [
                    props.microBatchStack.microBatchGlueStack.microBatchCentralizedDatabase.databaseArn,
                    `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${props.microBatchStack.microBatchGlueStack.microBatchCentralizedDatabase.databaseName}/*`,
                    `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:catalog`,
                ],
                actions: [
                    "glue:GetTable"
                ],
            })
        );

        const isCNRegion = new CfnCondition(this, 'isCNRegion', {
            expression: Fn.conditionEquals(Aws.PARTITION, 'aws-cn'),
        });

        pipelineHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [
                    Fn.conditionIf(isCNRegion.logicalId,
                        `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/*`,
                        `arn:${Aws.PARTITION}:scheduler:${Aws.REGION}:${Aws.ACCOUNT_ID}:schedule/*`
                    ).toString()
                ],
                actions: [
                    Fn.conditionIf(isCNRegion.logicalId, "events:DescribeRule", "scheduler:GetSchedule").toString()
                ],
            })
        );

        props.centralAssumeRolePolicy.attachToRole(pipelineHandler.role!);

        // Add pipeline lambda as a Datasource
        const pipeLambdaDS = props.graphqlApi.addLambdaDataSource(
            'PipelineLambdaDS',
            pipelineHandler,
            {
                description: 'Lambda Resolver Datasource',
            }
        );

        // Set resolver for releted cluster API methods
        pipeLambdaDS.createResolver('listServicePipelines', {
            typeName: 'Query',
            fieldName: 'listServicePipelines',
            requestMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/ListServicePipelines.vtl'
                )
            ),
            responseMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/ListServicePipelinesResp.vtl'
                )
            ),
        });

        pipeLambdaDS.createResolver('getServicePipeline', {
            typeName: 'Query',
            fieldName: 'getServicePipeline',
            requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
            responseMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/GetServicePipelineResp.vtl'
                )
            ),
        });

        pipeLambdaDS.createResolver('createServicePipeline', {
            typeName: 'Mutation',
            fieldName: 'createServicePipeline',
            requestMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/CreateServicePipeline.vtl'
                )
            ),
            responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
        });

        pipeLambdaDS.createResolver('createLightEngineServicePipeline', {
            typeName: 'Mutation',
            fieldName: 'createLightEngineServicePipeline',
            requestMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/CreateLightEngineServicePipeline.vtl'
                )
            ),
            responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
        });

        pipeLambdaDS.createResolver('deleteServicePipeline', {
            typeName: 'Mutation',
            fieldName: 'deleteServicePipeline',
            requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
            responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
        });

        pipeLambdaDS.createResolver('getLightEngineServicePipelineDetail', {
            typeName: 'Query',
            fieldName: 'getLightEngineServicePipelineDetail',
            requestMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/GetLightEngineServicePipelineDetail.vtl'
                )
            ),
            responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
        });

        pipeLambdaDS.createResolver('getLightEngineServicePipelineExecutionLogs', {
            typeName: 'Query',
            fieldName: 'getLightEngineServicePipelineExecutionLogs',
            requestMappingTemplate: appsync.MappingTemplate.fromFile(
                path.join(
                    __dirname,
                    '../../graphql/vtl/pipeline/GetLightEngineServicePipelineExecutionLogs.vtl'
                )
            ),
            responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
        });
    }
}
