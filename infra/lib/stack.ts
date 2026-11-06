// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * EC2 host deployment (design 10, 11).
 *
 * context (cdk.json or -c):
 *   vpcId                  reuse an existing VPC (needs a private subnet with NAT egress); a new one (1 NAT) is created when omitted
 *   releaseWriterArns      ARNs of IAM principals allowed to write to the release bucket (comma separated), used by `npm run release -- --upload`
 *   alarmEmail             email address for alarms (optional)
 *   trailLogGroupName      CloudWatch Logs group of an existing CloudTrail to reuse; a new trail that records management events only is created when omitted
 *   authCallsPerHourAlarm  hourly alarm threshold for Cognito token-minting calls (default 600)
 */
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  Token,
  Validations,
  type StackProps,
  aws_cloudtrail as cloudtrail,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_cognito as cognito,
  aws_dlm as dlm,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as sm,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICE = 'agentcore-feishu-bot';

export class AgentCoreFeishuBotStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const ctx = (k: string): string | undefined => {
      const v = this.node.tryGetContext(k);
      return v === undefined || v === '' ? undefined : String(v);
    };

    // ---------- Network: private subnet, no inbound rules, S3 gateway endpoint ----------
    const vpcId = ctx('vpcId');
    const vpc = vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 2,
          natGateways: 1,
          subnetConfiguration: [
            { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
          ],
        });
    // When reusing a VPC it does not matter if the endpoint is not created again: several S3 gateway endpoints on the same route table cause an error, so it is added only for a new VPC
    if (!vpcId) {
      vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
      // Rejected traffic only: enough to troubleshoot egress, and keeps log volume low
      vpc.addFlowLog('FlowLog', {
        destination: ec2.FlowLogDestination.toCloudWatchLogs(
          new logs.LogGroup(this, 'FlowLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        ),
        trafficType: ec2.FlowLogTrafficType.REJECT,
      });
    }

    const sg = new ec2.SecurityGroup(this, 'HostSg', {
      vpc,
      description: `${SERVICE} host: no inbound rules`,
      allowAllOutbound: true,
    });

    // ---------- Cognito user pool: used only to mint tokens (design 5.3, 10) ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${SERVICE}-users`,
      selfSignUpEnabled: false,
      // Do not enable usernameAttributes: the username is an arbitrary string (userKey)
      signInAliases: { username: true },
      signInCaseSensitive: true,
      // Explicit password policy that does not rely on defaults; derived passwords always satisfy it (design 5.3)
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(1),
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,
      // No threat protection: all authentication comes from the same host and would be judged a suspicious sign-in
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      // Deleting it would give every user a new identity (the sub changes), so it is not deleted with the stack
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Validations.of(userPool).acknowledge({
      id: 'AwsSolutions-COG2',
      reason: 'No person signs in to this pool: users are created and authenticated only by the host (AdminInitiateAuth) to mint JWTs, so there is no second factor to present.',
    });
    Validations.of(userPool).acknowledge({
      id: 'AwsSolutions-COG8',
      reason: 'Threat protection (Plus tier) is not used: every sign-in comes from the same host with server-derived passwords, so adaptive authentication would flag normal traffic. Token minting is monitored by the CloudTrail alarms below.',
    });

    const hmacSecret = new sm.Secret(this, 'HmacSecret', {
      description: `${SERVICE}: HMAC key for deriving Cognito passwords`,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Validations.of(hmacSecret).acknowledge({
      id: 'AwsSolutions-SMG4',
      reason: 'Rotation is an operator action: rotating the secret must also reset every Cognito user password, which `agentcore-chat-bridge rotate-secret --apply` does (README "Rotate the HMAC key").',
    });

    // ---------- S3 server access logs for the release and trail buckets ----------
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Validations.of(accessLogsBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'This is the access log destination bucket; logging it to itself would loop.',
    });

    // ---------- Release bucket ----------
    const bucket = new s3.Bucket(this, 'ReleaseBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'release-bucket/',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const deployment = new s3deploy.BucketDeployment(this, 'ReleaseDeployment', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'releases/',
      sources: [s3deploy.Source.asset(path.join(ROOT, 'dist', 'releases'))],
      prune: false, // Do not delete old versions
      extract: true,
      memoryLimit: 512,
    });
    // The BucketDeployment handler (Lambda function and role) is generated and managed by aws-cdk-lib
    const orPseudo = (v: string, name: string) => (Token.isUnresolved(v) ? `<AWS::${name}>` : v);
    const assetBucket = `cdk-hnb659fds-assets-${orPseudo(this.account, 'AccountId')}-${orPseudo(this.region, 'Region')}`;
    const bucketDeploymentReason = 'Generated by the aws-cdk-lib BucketDeployment construct, which copies the release package from the CDK asset bucket into the release bucket; its permissions are scoped to those two buckets.';
    for (const id of [
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'AwsSolutions-IAM5[Action::s3:GetBucket*]',
      'AwsSolutions-IAM5[Action::s3:GetObject*]',
      'AwsSolutions-IAM5[Action::s3:List*]',
      'AwsSolutions-IAM5[Action::s3:Abort*]',
      'AwsSolutions-IAM5[Action::s3:DeleteObject*]',
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${assetBucket}/*]`,
      'AwsSolutions-IAM5[Resource::<ReleaseBucket49D06018.Arn>/*]',
    ]) {
      Validations.of(deployment.handlerRole).acknowledge({ id, reason: bucketDeploymentReason });
    }
    for (const c of this.node.children.filter((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'))) {
      Validations.of(c).acknowledge({
        id: 'AwsSolutions-L1',
        reason: 'The BucketDeployment handler runtime is chosen by aws-cdk-lib and moves forward with aws-cdk-lib upgrades.',
      });
    }

    // Bucket policy: only deployment roles (the BucketDeployment handler, the CDK deployment roles, and explicitly listed publishers) can write
    const writers = [
      deployment.handlerRole.roleArn,
      `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-*`,
      `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:root`,
      ...(ctx('releaseWriterArns')?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
    ];
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OnlyDeployRolesWrite',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectAcl'],
        resources: [bucket.arnForObjects('*')],
        conditions: { StringNotLike: { 'aws:PrincipalArn': writers } },
      }),
    );

    // ---------- Instance role (least privilege, design 10) ----------
    const role = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `${SERVICE} host role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    Validations.of(role).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore]',
      reason: 'Standard policy for SSM Session Manager, the only way administrators reach the host (it has no inbound ports).',
    });
    Validations.of(role).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/CloudWatchAgentServerPolicy]',
      reason: 'Standard policy for the CloudWatch agent that ships the service logs and host metrics.',
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CognitoSignTokens',
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:ListUsers',
          'cognito-idp:CreateUserPoolClient',
          'cognito-idp:DescribeUserPoolClient',
          'cognito-idp:DeleteUserPoolClient',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreReadRuntimes',
        // ListAgentRuntimes has no resource types in the Service Authorization Reference, so Resource must be "*"
        actions: ['bedrock-agentcore:ListAgentRuntimes'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentCoreReadRuntimeConfig',
        actions: [
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:GetAgentRuntimeEndpoint',
          'bedrock-agentcore:ListAgentRuntimeEndpoints',
        ],
        resources: [
          `arn:${Aws.PARTITION}:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:runtime/*`,
        ],
      }),
    );
    hmacSecret.grantRead(role); // GetSecretValue / DescribeSecret, including AWSPREVIOUS
    role.addToPolicy(
      new iam.PolicyStatement({ sid: 'ReadReleases', actions: ['s3:GetObject'], resources: [bucket.arnForObjects('releases/*')] }),
    );
    Validations.of(role).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'Only bedrock-agentcore:ListAgentRuntimes uses Resource "*"; the action does not support resource-level permissions.',
    });
    Validations.of(role).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock-agentcore:<AWS::Region>:<AWS::AccountId>:runtime/*]',
      reason: 'Read-only Get/List on runtimes in this account and region: which runtimes are bound is decided at run time by `agentcore-chat-bridge bind`, not at deploy time.',
    });
    Validations.of(role).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::<ReleaseBucket49D06018.Arn>/releases/*]',
      reason: 'Read-only s3:GetObject under the releases/ prefix of the release bucket; version directories are created by each release.',
    });

    // ---------- EC2 instance ----------
    const hostScript = (f: string) => readFileSync(path.join(ROOT, 'host', f), 'utf8');
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'install -d -o root -g root -m 0755 /etc/agentcore-feishu-bot /opt/agentcore-feishu-bot/bin',
      'cat > /etc/agentcore-feishu-bot/host.env <<EOF',
      `AFB_RELEASE_BUCKET=${bucket.bucketName}`,
      `AFB_REGION=${Aws.REGION}`,
      `AWS_REGION=${Aws.REGION}`,
      `AFB_USER_POOL_ID=${userPool.userPoolId}`,
      `AFB_HMAC_SECRET_ARN=${hmacSecret.secretArn}`,
      'EOF',
      'chmod 0644 /etc/agentcore-feishu-bot/host.env',
      // The fetch script and bootstrap are written directly into user data (later upgrades use the new version in the release package)
      "cat > /opt/agentcore-feishu-bot/bin/afb-fetch-release <<'AFB_EOF'",
      hostScript('fetch-release.sh'),
      'AFB_EOF',
      'chmod 0755 /opt/agentcore-feishu-bot/bin/afb-fetch-release',
      "cat > /root/afb-bootstrap.sh <<'AFB_EOF'",
      hostScript('bootstrap.sh'),
      'AFB_EOF',
      'bash /root/afb-bootstrap.sh',
    );

    const instance = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role,
      associatePublicIpAddress: false,
      requireImdsv2: true,
      userData,
      userDataCausesReplacement: false,
      propagateTagsToVolumeOnCreation: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3, deleteOnTermination: true }),
        },
      ],
    });
    Validations.of(instance).acknowledge({
      id: 'AwsSolutions-EC28',
      reason: 'Basic monitoring is enough for a single sample host; the CloudWatch agent already ships memory and disk metrics and the service logs.',
    });
    Validations.of(instance).acknowledge({
      id: 'AwsSolutions-EC29',
      reason: 'Termination protection would block `cdk destroy` in the Clean up steps; the root volume is backed up daily by the DLM policy below.',
    });
    // When the instance starts, releases/LATEST always exists (design 10)
    instance.node.addDependency(deployment);
    Tags.of(instance).add('afb-backup', 'daily');
    Tags.of(instance).add('Name', SERVICE);

    // ---------- Backup: DLM snapshots the root volume daily and keeps 7 days; no cross-account or cross-region copy ----------
    const dlmRole = new iam.Role(this, 'DlmRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    });
    Validations.of(dlmRole).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole]',
      reason: 'The AWS-documented service role policy for Amazon Data Lifecycle Manager snapshot policies.',
    });
    new dlm.CfnLifecyclePolicy(this, 'DailySnapshots', {
      description: `${SERVICE} root volume daily snapshots`,
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'afb-backup', value: 'daily' }],
        schedules: [
          {
            name: 'daily-7d',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['18:00'] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });

    // ---------- CloudTrail → CloudWatch alarms (design 11) ----------
    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: `${SERVICE} alarms`, enforceSSL: true });
    const alarmEmail = ctx('alarmEmail');
    if (alarmEmail) topic.addSubscription(new subs.EmailSubscription(alarmEmail));

    const trailLogGroupName = ctx('trailLogGroupName');
    const trailLogGroup = trailLogGroupName
      ? logs.LogGroup.fromLogGroupName(this, 'TrailLogs', trailLogGroupName)
      : new logs.LogGroup(this, 'TrailLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });
    if (!trailLogGroupName) {
      new cloudtrail.Trail(this, 'Trail', {
        bucket: new s3.Bucket(this, 'TrailBucket', {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
          serverAccessLogsBucket: accessLogsBucket,
          serverAccessLogsPrefix: 'trail-bucket/',
          removalPolicy: RemovalPolicy.RETAIN,
        }),
        sendToCloudWatchLogs: true,
        cloudWatchLogGroup: trailLogGroup as logs.LogGroup,
        includeGlobalServiceEvents: false,
        isMultiRegionTrail: false,
        managementEvents: cloudtrail.ReadWriteType.ALL,
      });
    }
    const authEvents = '($.eventName = "AdminInitiateAuth") || ($.eventName = "AdminCreateUser") || ($.eventName = "AdminSetUserPassword")';
    const poolFilter = `($.eventSource = "cognito-idp.amazonaws.com") && ($.requestParameters.userPoolId = "${userPool.userPoolId}")`;

    const volumeMetric = new logs.MetricFilter(this, 'AuthCallsFilter', {
      logGroup: trailLogGroup,
      filterPattern: logs.FilterPattern.literal(`{ ${poolFilter} && (${authEvents}) }`),
      metricNamespace: SERVICE,
      metricName: 'CognitoAuthCalls',
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: Duration.hours(1) });
    new cw.Alarm(this, 'AuthCallsSpike', {
      alarmDescription: 'Spike in Cognito token-minting calls (baseline ≈ daily active users × bindings × password authentications per day)',
      metric: volumeMetric,
      threshold: Number(ctx('authCallsPerHourAlarm') ?? 600),
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(topic));

    const foreignMetric = new logs.MetricFilter(this, 'ForeignAuthCallsFilter', {
      logGroup: trailLogGroup,
      filterPattern: logs.FilterPattern.literal(
        `{ ${poolFilter} && (${authEvents}) && ($.userIdentity.sessionContext.sessionIssuer.arn != "${role.roleArn}") }`,
      ),
      metricNamespace: SERVICE,
      metricName: 'CognitoAuthCallsNotFromHost',
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: Duration.minutes(5) });
    new cw.Alarm(this, 'ForeignAuthCalls', {
      alarmDescription: 'An identity other than the instance role called AdminInitiateAuth / AdminCreateUser / AdminSetUserPassword',
      metric: foreignMetric,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(topic));

    // ---------- Outputs ----------
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'SsmCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${Aws.REGION}`,
      description: 'Log in to the host, then run agentcore-chat-bridge setup',
    });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'DiscoveryUrl', {
      value: `https://cognito-idp.${Aws.REGION}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
      description: 'customJWTAuthorizer.discoveryUrl for the customer runtime',
    });
    new CfnOutput(this, 'HmacSecretArn', { value: hmacSecret.secretArn });
    new CfnOutput(this, 'ReleaseBucketName', { value: bucket.bucketName, description: 'npm run release -- --upload --bucket <this value>' });
    new CfnOutput(this, 'AlarmTopicArn', { value: topic.topicArn });
  }
}
