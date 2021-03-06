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

var util = require('util');
var fs = require('fs');
var redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
var pcapInlet = require('../util/pcapInlet.js');
var udpToGrain = require('../util/udpToGrain.js');
var grainConcater = require('../util/grainConcater.js');
var Grain = require('node-red-contrib-dynamorse-core').Grain;
var SDPProcessing = require('node-red-contrib-dynamorse-core').SDPProcessing;
var H264 = require('../util/H264.js');

module.exports = function (RED) {
  function PCAPReader (config) {
    RED.nodes.createNode(this, config);
    redioactive.Funnel.call(this, config);

    fs.access(config.file, fs.R_OK, e => {
      if (e) return this.preFlightError(e);
    });
    let sourceID = null;
    let flowID = null;
    this.tags = {};
    this.grainCount = 0;
    this.baseTime = [ Date.now() / 1000|0, (Date.now() % 1000) * 1000000 ];

    this.sdpURLReader(config, (err/*, data*/) => {
      if (err) return this.preFlightError(err);

      this.exts = RED.nodes.getNode(
        this.context().global.get('rtp_ext_id')).getConfig();

      let cableSpec = {};
      cableSpec[this.tags.format] = [{ tags : this.tags }];
      cableSpec.backPressure = `${this.tags.format}[0]`;
      this.makeCable(cableSpec);
      flowID = this.flowID();
      sourceID = this.sourceID();

      var is6184 = this.tags.encodingName.toLowerCase() === 'h264';
      this.highland(
        pcapInlet(config.file, config.loop)
          .pipe(udpToGrain(this.exts, this.tags.format.endsWith('video') &&
          this.tags.encodingName === 'raw'))
          .map(g => {
            if (is6184) H264.backToAVC(g);
            if (!config.regenerate) {
              return new Grain(g.buffers, g.ptpSync, g.ptpOrigin, g.timecode,
                flowID, sourceID, g.duration);
            }
            var grainTime = Buffer.allocUnsafe(10);
            grainTime.writeUIntBE(this.baseTime[0], 0, 6);
            grainTime.writeUInt32BE(this.baseTime[1], 6);
            var grainDuration = g.getDuration();
            this.baseTime[1] = ( this.baseTime[1] +
            grainDuration[0] * 1000000000 / grainDuration[1]|0 );
            this.baseTime = [ this.baseTime[0] + this.baseTime[1] / 1000000000|0,
              this.baseTime[1] % 1000000000];
            return new Grain(g.buffers, grainTime, g.ptpOrigin, g.timecode,
              flowID, sourceID, g.duration);
          })
          .pipe(grainConcater(this, this.tags))
      );
    });
    this.on('close', () => {}); // Delete flows when we're done?
  }
  util.inherits(PCAPReader, redioactive.Funnel);
  RED.nodes.registerType('pcap-reader', PCAPReader);

  PCAPReader.prototype.sdpToTags = SDPProcessing.sdpToTags;
  PCAPReader.prototype.setTag = SDPProcessing.setTag;
  PCAPReader.prototype.sdpURLReader = SDPProcessing.sdpURLReaderDynamorse;
  PCAPReader.prototype.sdpToExt = SDPProcessing.sdpToExt;

  PCAPReader.prototype.testAccess = function (config) {
    setTimeout(() => { console.log('+=+', config, this.tags); }, 1000);
  };
};
