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
var RFC4175Packet = require('../model/RFC4175Packet.js');
var RTPPacket = require('../model/RTPPacket.js');
var Grain = require('node-red-contrib-dynamorse-core').Grain;
var SDP = require('node-red-contrib-dynamorse-core').SDPProcessing.SDP;
var dgram = require('netadon');
var uuid = require('uuid');
var Net = require('node-red-contrib-dynamorse-core').Net;
var H264 = require('../util/H264.js');

// TODO add IPv6 support

var fieldMap = {
  '576i'  : { field1Start : 23, field1End : 310, field2Start : 336, field2End : 623 },
  '720p'  : { field1Start : 26, field1End : 745 },
  '1080i' : { field1Start : 21, field1End : 560, field2Start : 584, field2End : 1123 },
  '1080p' : { field1Start : 42, field1End : 1121 },
  '2160p' : { field1Start : 0, field1End : 2159 },
  '4320p' : { field1Start : 0, field1End : 4319 }
};

function getStride (tags) {
  if (tags.encodingName === 'raw') {
    var depth = tags.depth;
    var spp = (tags.sampling.indexOf('4:4:4') >= 0) ? 3 :
      ((tags.sampling.indexOf('4:2:2') >= 0) ? 2 : 1.5);
    switch (depth) {
    case 8: return Math.ceil(spp);
    case 10: return 5;
    case 16: return spp * 2;
    }
  } else if (tags.format === 'audio') {
    if (tags.blockAlign) return tags.blockAlign;
    return tags.channels * tags.encodingName.substring(1) / 8|0;
  } else {
    return 1;
  }
}

function getByteFactor (tags) {
  var depth = tags.depth;
  var spp = (tags.sampling.indexOf('4:4:4') >= 0) ? 3 :
    ((tags.sampling.indexOf('4:2:2') >= 0) ? 2 : 1.5);
  return spp * depth / 8;
}

function checkNMOSFlow(nodeAPI, flowID) {
  return new Promise((resolve/*, reject*/) => {
    setTimeout(() => {
      nodeAPI.getResource(flowID, 'flow')
        .then(f => resolve(f), 
          () => resolve(null));
    }, 10);
  });
}
 
module.exports = function (RED) {
  function NMOSRTPOut (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);

    var seq = (Math.random() * 0xffffffff) >>> 0;
    var payloadType = 96;
    var rtpTsOffset = (Math.random() * 0xffffffff) >>> 0;
    var is4175 = false;
    var is6184 = false;
    var width = undefined;
    var height = undefined;
    var byteFactor = undefined;
    var interlace = false;
    var clockRate = 48000;
    var stride = 1;
    var syncSourceID = (Math.random() * 0xffffffff) >>> 0;
    var tsAdjust = 0; // Per packet timestamp adjustment - for samples / fields
    var lineStatus = null;
    var node = this;
    var srcFlowID = null;
    var srcTags = null;

    // Set up connection
    var sock = dgram.createSocket({type  :'udp4', reuseAddr : true});
    var bindCb = err => {
      if (err) return node.warn(err);
      sock.setMulticastTTL(config.ttl);
    };
    if (config.netif) { sock.bind(config.port, config.netif, bindCb); }
    else { sock.bind(config.port, bindCb); }

    var nodeAPI = this.context().global.get('nodeAPI');
    var ledger = this.context().global.get('ledger');
    var rtpExtDefID = this.context().global.get('rtp_ext_id');
    var rtpExts = RED.nodes.getNode(rtpExtDefID).getConfig();
    var localName = config.name || `${config.type}-${config.id}`;
    var localDescription = config.description || `${config.type}-${config.id}`;
    var genericID = this.context().global.get('genericID');
    var senderID = null;
    var sender = null;
    var sdp = null;
    var lastSend = null;
    var Packet = null;
    var packetsPerGrain = 100;

    this.each((g, next) => {
      this.log(`Received grain ${Grain.prototype.formatTimestamp(g.ptpSync)}.`);
      if (!Grain.isGrain(g)) {
        node.warn('Received a non-grain on the input.');
        return next();
      }

      var nextJob = srcTags ?
        Promise.resolve(g) :
        this.findCable(g)
          .then(cable => {
            let isVideo = Array.isArray(cable[0].video) && cable[0].video.length > 0;
            srcFlowID = isVideo ? cable[0].video[0].flowID : cable[0].audio[0].flowID;
            srcTags = isVideo ? cable[0].video[0].tags : cable[0].audio[0].tags;

            clockRate = srcTags.clockRate;
            is4175 = srcTags.encodingName === 'raw';
            is6184 = srcTags.encodingName.toLowerCase() === 'h264';
            if (is4175) {
              width = srcTags.width;
              height = srcTags.height;
              byteFactor = getByteFactor(srcTags);
              interlace = srcTags.interlace;
              Packet = RFC4175Packet;
              packetsPerGrain = width * height * byteFactor * 1.1 / 1452|0;
            } else {
              Packet = RTPPacket;
              // contentType = `${srcTags.format}/${srcTags.encodingName}`;
              // if (srcTags.clockRate) contentType += `; rate=${srcTags.clockRate}`;
              // if (srcTags.channels) contentType += `; channels=${srcTags.channels}`;
              // TODO something less arbitrary - problem is first H264 packet is small
              packetsPerGrain = (is6184) ? 1000 : (g.getPayloadSize() / 1400|0) + 5;
            }
            stride = getStride(srcTags);
          })
          .then(() => {
            const numTries = 10;
            let chain = Promise.resolve(null);
            for (let i=0; i<numTries; ++i) {
              chain = chain.then(f => {
                if (null === f) return checkNMOSFlow(nodeAPI, srcFlowID);
                else return Promise.resolve(f);
              });
            }
            return chain;
          })
          .then(() => {
            senderID = uuid.v4();
            sender = new ledger.Sender(senderID, null, localName, localDescription,
              srcFlowID, Net.isMulticast(config.address) ?
                'urn:x-nmos:transport:rtp.mcast' : 'urn:x-nmos:transport:rtp.ucast',
              genericID, // TODO do better at binding to an address
              `http://${Net.getFirstRealIP4Interface().address}:${nodeAPI.getPort()}/sdp/${senderID}.sdp`);

            nodeAPI.putResource(sender)
              .then(() => {
                sdp = SDP.makeSDP(config, srcTags, rtpExts, rtpTsOffset);
                nodeAPI.putSDP(senderID, sdp.toString());
              })
              .then(() =>  node.log(`Registered NMOS sender resource ${senderID}.`))
              .catch(node.warn);
          });
      
      nextJob.then(() => {
        pushGrain(g, next);
      });
    });

    var count = 0; //, timeoutTune = 0;
    var grainTimer = process.hrtime();

    function pushGrain (g, next) {
      console.log(':-)', process.hrtime(grainTimer));
      if (is6184) H264.compact(g, 1410);
      var masterBuffer = Buffer.alloc(packetsPerGrain*1452);
      var pc = 0;
      grainTimer = process.hrtime();
      lineStatus = (is4175) ? {
        width: width, stride: stride, lineNo: 21,
        bytesPerLine: width * byteFactor, byteFactor: byteFactor, linePos: 0,
        fieldBreaks: fieldMap[height + ((interlace) ? 'i' : 'p')],
        field : 1
      } : undefined;
      var remaining = 1200; // Allow for extension
      var packet = makePacket(g, remaining, masterBuffer, pc++);

      // Make grain start RTP header extension
      var startExt = { profile : 0xbede };
      startExt['id' + rtpExts.grain_flags_id] = Buffer.from([0x80]);
      startExt['id' + rtpExts.origin_timestamp_id] = g.ptpOrigin;
      startExt['id' + rtpExts.sync_timestamp_id] = g.ptpSync;
      startExt['id' + rtpExts.grain_duration_id] = g.duration;
      startExt['id' + rtpExts.flow_id_id] = g.flow_id;
      startExt['id' + rtpExts.source_id_id] = g.source_id;
      startExt['id' + rtpExts.smpte_tc_id] = g.timecode;
      var actualExts = packet.setExtensions(startExt);
      if (actualExts.prototype && actualExts.prototype.name === 'Error')
        node.warn(`Failed to set header extensions: ${actualExts}`);

      var i = 0, o = 0;
      var b = g.buffers[i];
      while (i < g.buffers.length) {
        if (is6184) {
          b = g.buffers[i++];
          if (i < g.buffers.length) {
            packet.setPayload(b);
            sendPacket(packet);
            remaining = 1410;
            packet = makePacket(g, remaining, masterBuffer, pc++);
          }
          continue;
        }
        var t = (!is4175 || !packet.getMarker()) ? remaining - remaining % stride :
          packet.getLineData()[0].length;
        // console.log('HAT', packet.getLineData()[0].lineNo, (b.length - o) % 4800, 4800 - lineStatus.linePos,
        //   ((b.length - o) % 4800) - (4800 - lineStatus.linePos));
        // console.log(b.length, o, t, remaining, (b.length - o) >= t);
        if ((b.length - o) >= t) {
          if (is4175 && interlace && (lineStatus.lineNo > packet.getLineData()[0].lineNo)) {
            // !!! doesn't currently handle > 2 line parts in a packet
            if (lineStatus.lineNo === lineStatus.fieldBreaks.field2Start) {
              packet.setPayload(b.slice(o, o + t));
              o = lineStatus.bytesPerLine;
            } else {
              var newLineOff = o + (t - lineStatus.linePos) + lineStatus.bytesPerLine;
              packet.setPayload(Buffer.concat([b.slice(o, o + (t - lineStatus.linePos)),
                b.slice(newLineOff, newLineOff + lineStatus.linePos)], t));
              o = newLineOff + lineStatus.linePos;
            }
          } else {
            packet.setPayload(b.slice(o, o + t));
            o += t;
          }
          sendPacket(packet); // May want to spread packets
          // FIXME: probably won't work for compressed video
          if (!is4175) tsAdjust += t / stride;
          remaining = 1410; // Slightly short so last header fits
          packet = makePacket(g, remaining, masterBuffer, pc++);
        } else if (++i < g.buffers.length) {
          console.log('Getting next buffer.'); // Not called when one buffer per grain - now the default
          b = Buffer.concat([b.slice(o), g.buffers[i]],
            b.length + g.buffers[i].length - o);
          o = 0;
        } else {
          // console.log("Shrinking buffer.", o, t, b.length);
          // Required to shrink last packet of the set.
          b = b.slice(o);
        }
      }
      var endExt = { profile : 0xbede };
      endExt['id' + rtpExts.grain_flags_id] = Buffer.from([0x40]);
      packet.setExtensions(endExt);
      packet.setMarker(true);
      packet.setPayload(b);

      function waitNext() {
        var gap = process.hrtime(lastSend);
        // console.log('Waiting gap', gap);
        if (gap[0] * 1000 + gap[1] / 1000000 < config.timeout * count) {
          // timeoutTune++;
          setTimeout(waitNext, 1);
        } else {
          // console.log('Waiting', timeoutTune, (gap[0] * 1000 + gap[1] / 1000000) / count);
          next();
        }
      }

      sendPacket(packet, next);
      console.log(':-(', process.hrtime(grainTimer));
      masterBuffer = null;

      if (config.timeout === 0) {
        setImmediate(next);
      } else {
        if (!lastSend || process.hrtime(lastSend)[0] > config.timeout * (count + 2) / 1000) {
          node.log('Resetting timer at start or due to large gap.');
          lastSend = process.hrtime(); count = 0;
        }
        count++;
        // timeoutTune = 0;
        setTimeout(waitNext, config.timeout - 5);
      }
      console.log(':-((', process.hrtime(grainTimer));
    }
    function makePacket (g, remaining, buf, pc) {
      // var packetMaker = process.hrtime();
      // var buf = Buffer.alloc(1452);
      // var packet = new Packet(buf);
      // var bufAlloc = process.hrtime(packetMaker);
      var packet = new Packet(buf.slice(pc*1452, pc*1452+1452));
      // console.log('Made buffer in', bufAlloc, 'packet in', process.hrtime(packetMaker));
      packet.setVersion(2);
      packet.setPadding(false);
      packet.setExtension(false);
      packet.setCSRCCount(0);
      packet.setMarker(false);
      packet.setPayloadType(payloadType);
      packet.setSequenceNumber(seq & 65535);
      if (is4175) packet.setExtendedSequenceNumber(seq >>> 16);
      seq = (seq <= 0xffffffff) ? seq + 1 : 0;
      // Special shift >>> 0 is a cheat to get a UInt32
      // Not updating audio timestamps as per pcaps
      packet.setTimestamp((g.originAtRate(clockRate) + rtpTsOffset + tsAdjust) >>> 0);
      packet.setSyncSourceID(syncSourceID);
      if (is4175) {
        lineStatus = packet.setLineDataHeaders(lineStatus, remaining);
        if (lineStatus.field == 2) {
          tsAdjust = 1800; // TODO Find a frame rate adjust
        }
      }
      // console.log('Packet maker', process.hrtime(packetMaker));
      return packet;
    }

    // var packetCount = 0;
    // var callbackCount = 0;
    // var packetTime = process.hrtime();
    var packetBuffers = [];
    function sendPacket (p, done) {
      // console.log('\_/', p.getExtension(), p.getExtendedSequenceNumber(), p.getSequenceNumber());
      packetBuffers.push(p.buffer);
      if (done) {
        // packetCount++;
        sock.send(packetBuffers, config.port, config.address, e => {
          // callbackCount++;
          // done();
          if (e) return console.error(e);
        });
        packetBuffers = [];
        // console.log('+++', packetCount, callbackCount, process.hrtime(packetTime)[1]/1000000);
        // packetTime = process.hrtime();
      }
    }
    this.errors((e, next) => {
      this.warn(`Received unhandled error: ${e.message}.`);
      if (config.timeout === 0) setImmediate(next);
      else setTimeout(next, config.timeout);
    });
    this.done(() => {
      this.log('Stream has all dried up!');
      if (sock) sock.close();
      nodeAPI.deleteResource(senderID, 'sender').catch(node.warn);
      // TODO remove other resources?
    });
  }
  util.inherits(NMOSRTPOut, redioactive.Spout);
  RED.nodes.registerType('nmos-rtp-out', NMOSRTPOut);
};
