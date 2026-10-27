'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let ENV_SUB;
let ENV_PORT;
let ENV_SUB_PATH;
let ENV_DOMAIN;
let ENV_AUTO_ACCESS;
let ENV_ARGO_DOMAIN;
let ENV_ARGO_AUTH;
let ENV_TLS;

