// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** setup/scopes.json: minimal permissions, events, and callbacks (design 4.4) */
import manifest from '../../setup/scopes.json' with { type: 'json' };

export const SCOPES: { tenant: string[]; events: string[]; callbacks: string[] } = manifest;
