/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

var TestUtil = require('dynamorse-test');

var pcapTestNode = JSON.stringify({
  'type': 'pcap-reader',
  'z': TestUtil.testFlowId,
  'name': 'pcap-reader-test',
  'maxBuffer': 10,
  'wsPort': TestUtil.properties.wsPort,
  'x': 100.0,
  'y': 100.0,
  'wires': [[]]
});
var pcapNodeId = '24fde3d7.b7544c';
var spoutNodeId = 'f2186999.7e5f78';

TestUtil.nodeRedTest('A pcap-reader->spout flow is posted to Node-RED', {
  pcapFilename: __dirname + '/data/rtp-video-rfc4175-1080i50-colour.pcap',
  sdpFilename: __dirname + '/data/sdp_rfc4175_10bit_1080i50.sdp',
  maxBuffer: 10,
  spoutTimeout: 0
}, params => {
  var testFlow = JSON.parse(TestUtil.testNodes.baseTestFlow);
  testFlow.nodes[0] = JSON.parse(pcapTestNode);
  testFlow.nodes[0].id = pcapNodeId;
  testFlow.nodes[0].file = params.pcapFilename,
  testFlow.nodes[0].sdpURL = `file:${params.sdpFilename}`,
  testFlow.nodes[0].maxBuffer = params.maxBuffer;
  testFlow.nodes[0].wires[0][0] = spoutNodeId;

  testFlow.nodes[1] = JSON.parse(TestUtil.testNodes.spoutTestNode);
  testFlow.nodes[1].id = spoutNodeId;
  testFlow.nodes[1].timeout = params.spoutTimeout;
  return testFlow;
}, (t, params, msgObj, onEnd) => {
  //t.comment(`Message: ${JSON.stringify(msgObj)}`);
  if (msgObj.hasOwnProperty('receive')) {
    TestUtil.checkGrain(t, msgObj.receive);
    params.count++;
  }
  else if (msgObj.hasOwnProperty('end') && (msgObj.src === 'spout')) {
    onEnd();
  }
});

