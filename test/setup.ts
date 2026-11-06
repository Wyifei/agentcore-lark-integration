// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { setLogSink } from '../src/util/log.ts';

// No log output in tests; cases that need to check logs set their own sink
setLogSink(() => {});
