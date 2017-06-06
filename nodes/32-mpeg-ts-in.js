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

var redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
var Grain = require('node-red-contrib-dynamorse-core').Grain;
var util = require('util');
var http = require('http');
var tesladon = require('tesladon');
var H = require('highland');
var uuid = require('uuid');

module.exports = function (RED) {
  function MPEGTSIn (config) {
    RED.nodes.createNode(this,config);
    redioactive.Funnel.call(this, config);

    if (!this.context().global.get('updated'))
      return this.log('Waiting for global context to be updated.');
    var nodeAPI = this.context().global.get('nodeAPI');
    var ledger = this.context().global.get('ledger');
    var source = null;
    var flow = null;
    var tags = {};
    var localName = config.name || `${config.type}-${config.id}`;
    var localDescription = config.description || `${config.type}-${config.id}`;
    var pipelinesID = config.device ?
      RED.nodes.getNode(config.device).nmos_id :
      this.context().global.get('pipelinesID');
    source = new ledger.Source(null, null, localName, localDescription,
      "urn:x-nmos:format:" + this.tags.format[0], null, null, pipelinesID, null);
    flow = new ledger.Flow(null, null, localName, localDescription,
      "urn:x-nmos:format:" + this.tags.format[0], this.tags, source.id, null);

    var node = this;
    var flowID = flow.id;
    var sourceID = source.id;
    http.get(config.source, res => {
      this.highland(H(res)
        .pipe(tesladon.bufferGroup(188))
        .pipe(tesladon.readTSPackets())
        .pipe(tesladon.readPAT(true))
        .pipe(tesladon.readPMTs(true))
        .pipe(tesladon.readPESPackets(true))
        .filter(x => x.type === 'PESPacket' && x.pid === 4096)
        .doto(console.log)
        .map(x => new Grain(x.payloads,
          tesladon.tsTimeToPTPTime(x.pts),
          tesladon.tsTimeToPTPTime(x.pts),
          null, flowID, sourceID, "25/1")));
    });
  }
  util.inherits(MPEGTSIn, redioactive.Funnel);
  RED.nodes.registerType("mpeg-ts-in", MPEGTSIn);
}
