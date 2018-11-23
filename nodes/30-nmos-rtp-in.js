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
var util = require('util');
var SDPProcessing = require('node-red-contrib-dynamorse-core').SDPProcessing;
var dgram = require('netadon');
var udpInlet = require('../util/udpInlet.js');
var udpToGrain = require('../util/udpToGrain.js');
var grainConcater = require('../util/grainConcater.js');
var Grain = require('node-red-contrib-dynamorse-core').Grain;
var H264 = require('../util/H264.js');
var http = require('http');
var mdns = null;

module.exports = function (RED) {
  function NmosRTPIn (config) {
    RED.nodes.createNode(this,config);
    redioactive.Funnel.call(this, config);

    var node = this;
    let sourceID = null;
    let flowID = null;
    this.tags = {};
    this.exts = {};
    this.sdp = {};
    var browser = null;
    var client = dgram.createSocket({type  :'udp4', reuseAddr : true});
    this.baseTime = [ Date.now() / 1000|0, (Date.now() % 1000) * 1000000 ];

    (new Promise((complete, reject) => {
      if (!config.sender) return complete();
      if (config.sender.startsWith('http')) return complete();
      var selectionTimer = null;
      var candidates = [];
      if (!mdns) mdns = require('mdns-js');
      browser = mdns.createBrowser('_nmos-query._tcp.local.');
      mdns.excludeInterface('0.0.0.0');
      function selectCandidate(candidates) {
        var extractPri = x => {
          console.log(x.txt[0]);
          var match = x.txt[0].match(/pri=([0-9]+)/);
          if (match) return +match[1];
          else return NaN;
        };
        if (candidates.length > 0) {
          var selected = candidates.sort((x, y) => extractPri(x) > extractPri(y))[0];
          node.log(`Selected query service at http://${selected.addresses[0]}:${selected.port} ` +
            `with priority ${extractPri(selected)}.`);
          if (config.sender.indexOf('=') < 0 && !config.sender.endsWith('/'))
            config.sender = config.sender + '/';
          else config.sender = '?' + config.sender;
          config.sender =
            `http://${selected.addresses[0]}:${selected.port}/x-nmos/query/v1.0/senders/${config.sender}`;
          browser.stop();
          complete();
        } else {
          reject('Failed to find a query service.');
        }
      } // selectCandidate
      browser.on('ready', () => {
        node.log('Ready for MDNS.');
        candidates = [];
        browser.discover();
      });
      browser.on('update', (data) => {
        node.log('MDNS update');
        if (data.fullname && data.fullname.indexOf('_nmos-query._tcp') >= 0) {
          node.log(`Found a query service ${data.fullname} ${(data.txt.length > 0) ? data.txt[0] : ''}`);
          candidates.push(data);
          if (!selectionTimer) selectionTimer = setTimeout(() => {
            selectCandidate(candidates);
          }, 1000);
        }
      });
      browser.on('error', reject);
    }))
      .then(() => {
        return new Promise((complete, reject) => {
          if (!config.sender) return complete();
          http.get(config.sender, (res) => {
            res.on('error', reject);
            if (!res.statusCode === 200)
              return reject(`Error code ${res.statusCode} when requesting sender details.`);
            var senderStr = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { senderStr += chunk; });
            res.on('end',  () => {
              var sender = JSON.parse(senderStr);
              if (Array.isArray(sender)) sender = sender[0];
              config.sdpURL = sender.manifest_href;
              config.sender = sender.id;
              complete();
            });
          });
        });
      })
      .then(() => this.sdpURLReader(config))
      .then(() => {
        let cableSpec = {};
        cableSpec[this.tags.format] = [{ tags : this.tags }];
        cableSpec.backPressure = `${this.tags.format}[0]`;
        this.makeCable(cableSpec);
        flowID = this.flowID();
        sourceID = this.sourceID();

        console.log('Starting highland pipeline.');
        var is6184 = this.tags.encodingName.toLowerCase() === 'h264';
        this.highland(
          udpInlet(client, this.sdp, 0, config.netif)
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
      })
      .catch((err) => {
        node.log(`Unable to start NMOS RTP in: ${err}`);
      });
    this.on('close', () => {
      if (browser) browser.stop();
    }); // Delete flows when we're done?
  }
  util.inherits(NmosRTPIn, redioactive.Funnel);
  RED.nodes.registerType('nmos-rtp-in', NmosRTPIn);

  NmosRTPIn.prototype.sdpToTags = SDPProcessing.sdpToTags;
  NmosRTPIn.prototype.setTag = SDPProcessing.setTag;
  NmosRTPIn.prototype.sdpURLReader = util.promisify(SDPProcessing.sdpURLReaderDynamorse);
  NmosRTPIn.prototype.sdpToExt = SDPProcessing.sdpToExt;
};
