// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentCoreFeishuBotStack } from '../lib/stack.ts';

const app = new App();
new AgentCoreFeishuBotStack(app, 'AgentCoreFeishuBot', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'Feishu bot for Amazon Bedrock AgentCore Runtime (Strands agents)',
});
// cdk-nag AwsSolutions rules: synth fails on unacknowledged errors; acknowledgements with reasons are in lib/stack.ts
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
