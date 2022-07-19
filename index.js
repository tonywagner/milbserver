#!/usr/bin/env node

// index.js sets up web server and listens for and responds to URL requests

// Required Node packages
const minimist = require('minimist')
const root = require('root')
const path = require('path')
const url = require('url')
const assert = require('assert')
var crypto = require('crypto')

// More required Node packages, for multiview streaming
const HLSServer = require('hls-server')
const http = require('http')
const httpAttach = require('http-attach')
const ffmpeg = require('fluent-ffmpeg')

// Declare our session class for API activity, from the included session.js file
const sessionClass = require('./session.js')

// Define some valid variable values, the first one being the default
const VALID_DATES = [ 'today', 'yesterday' ]
const YESTERDAY_UTC_HOURS = 14 // UTC hours (EST + 4) to change home page default date from yesterday to today
const VALID_LINK_TYPES = [ 'Embed', 'Stream', 'Chromecast', 'Advanced' ]
const VALID_START_FROM = [ 'Beginning', 'Live' ]
const VALID_CONTROLS = [ 'Show', 'Hide' ]
const VALID_INNING_HALF = [ '', 'top', 'bottom' ]
const VALID_INNING_NUMBER = [ '', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12' ]
const VALID_SCORES = [ 'Hide', 'Show' ]
const VALID_RESOLUTIONS = [ 'adaptive', '720p60', '540p', '360p', '216p' ]
const DEFAULT_MULTIVIEW_RESOLUTION = '540p'
// Corresponding andwidths to display for above resolutions
const DISPLAY_BANDWIDTHS = [ '', '5165k', '3219k', '1496k', '654k' ]
const VALID_FORCE_VOD = [ 'off', 'on' ]
const VALID_SKIP = [ 'off', 'breaks', 'idle time', 'pitches' ]
const DEFAULT_SKIP_ADJUST = 0
const VALID_PAD = [ 'off', 'on' ]
const VALID_SCAN_MODES = [ 'off', 'on' ]

const SAMPLE_STREAM_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'

const SECONDS_PER_SEGMENT = 4

const AFFILIATES = { 'Angels': '401,559,561,460', 'Astros': '3712,573,482,5434', 'Athletics': '237,400,524,499', 'Blue Jays': '422,424,435,463', 'Braves': '430,431,432,478', 'Brewers': '249,556,572,5015', 'Cardinals': '235,279,440,443', 'Cubs': '521,553,451,550', 'D-backs': '2310,419,516,5368', 'Dodgers': '238,260,526,456', 'Giants': '3410,105,461,476', 'Guardians': '402,437,445,481', 'Mariners': '403,515,529,574', 'Marlins': '4124,564,554,479', 'Mets': '552,453,505,507', 'Nationals': '436,426,534,547', 'Orioles': '418,568,488,548', 'Padres': '103,584,510,4904', 'Phillies': '1410,427,522,566', 'Pirates': '3390,452,477,484', 'Rangers': '102,540,448,485', 'Rays': '233,234,421,2498', 'Red Sox': '414,428,533,546', 'Reds': '416,450,459,498', 'Rockies': '259,342,538,486', 'Royals': '3705,1350,541,565', 'Tigers': '106,570,582,512', 'Twins': '3898,492,509,1960', 'White Sox': '247,580,487,494', 'Yankees': '531,587,1956,537' }

// Process command line arguments, if specified:
// --port or -p (default 9990)
// --debug or -d (false if not specified)
// --logout or -l (logs out and clears session)
// --session or -s (clears session)
// --cache or -c (clears cache)
// --version or -v (returns package version number)
//
// Advanced command line arguments:
// --account_username (email address, default will use stored credentials or prompt user to enter them)
// --account_password (default will use stored credentials or prompt user to enter them)
// --multiview_port (port for multiview streaming; defaults to 1 more than primary port, or 9991)
// --multiview_path (where to create the folder for multiview encoded files; defaults to app directory)
// --ffmpeg_path (path to ffmpeg binary to use for multiview encoding; default downloads a binary using ffmpeg-static)
// --ffmpeg_encoder (ffmpeg video encoder to use for multiview; default is the software encoder libx264)
// --ffmpeg_logging (if present, logs all ffmpeg output -- useful for experimenting or troubleshooting)
// --page_username (username to protect pages; default is no protection)
// --page_password (password to protect pages; default is no protection)
// --content_protect (specify the content protection key to include as a URL parameter, if page protection is enabled)
var argv = minimist(process.argv, {
  alias: {
    p: 'port',
    d: 'debug',
    l: 'logout',
    s: 'session',
    c: 'cache',
    v: 'version'
  },
  boolean: ['ffmpeg_logging', 'debug', 'logout', 'session', 'cache', 'version'],
  string: ['port', 'account_username', 'account_password', 'multiview_port', 'multiview_path', 'ffmpeg_path', 'ffmpeg_encoder', 'page_username', 'page_password', 'content_protect']
})

// Version
var version = require('./package').version
console.log('Version ' + version)
if (argv.version) return

// Declare a session, pass arguments to it
var session = new sessionClass(argv)

// Clear cache (cache data, not images)
if (argv.cache) {
  session.log('Clearing cache...')
  session.clear_cache()
  session = new sessionClass(argv)
}

// Clear session
if (argv.session) {
  session.log('Clearing session data...')
  session.clear_session_data()
  session = new sessionClass(argv)
}

// Logout (also implies clearing session)
if (argv.logout) {
  session.log('Logging out...')
  session.logout()
  if (!argv.session) {
    session.clear_session_data()
  }
  session = new sessionClass(argv)
}

// Set FFMPEG path, download if necessary
const pathToFfmpeg = argv.ffmpeg_path || require('ffmpeg-static')
ffmpeg.setFfmpegPath(pathToFfmpeg)

// Set FFMPEG encoder, use libx264 if not specified
const defaultEncoder = 'libx264'
const ffmpegEncoder = argv.ffmpeg_encoder || defaultEncoder

// Declare web server
var app = root()

// Get appname from directory
var appname = path.basename(__dirname)

// Multiview server variables
var hls_base = 'multiview'
var multiview_stream_name = 'master.m3u8'
var multiview_url_path = '/' + hls_base + '/' + multiview_stream_name
if ( session.protection.content_protect ) multiview_url_path += '?content_protect=' + session.protection.content_protect
session.setMultiviewStreamURLPath(multiview_url_path)
var ffmpeg_command
var ffmpeg_status = false

// Start web server listening on port
// and also multiview server on its port (next one if not defined otherwise)
let port = argv.port || 9990
let multiview_port = argv.multiview_port || port + 1
session.setPorts(port, multiview_port)
app.listen(port, function(addr) {
  session.log(appname + ' started at http://' + addr)
  session.debuglog('multiview port ' + multiview_port)
  session.debuglog('multiview server started at http://' + addr.replace(':' + port, ':' + multiview_port) + multiview_url_path)
  if (ffmpegEncoder == defaultEncoder) {
    session.debuglog('warning: multiview is set to use software encoding -- see the readme for how to configure hardware encoding (to reduce multiview CPU usage and improve multiview performance)')
  }
  session.clear_multiview_files()
})
var multiview_app = http.createServer()
var hls = new HLSServer(multiview_app, {
  path: '/' + hls_base,
  dir: session.get_multiview_directory()
})
function corsMiddleware (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next()
}
httpAttach(multiview_app, corsMiddleware)
multiview_app.listen(multiview_port)

// Listen for stream requests
app.get('/stream.m3u8', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  try {
    session.requestlog('stream.m3u8', req)

    let gamePk
    let streamURL
    let options = {}
    let urlArray = req.url.split('?')
    if ( (urlArray.length == 1) || ((session.data.scan_mode == VALID_SCAN_MODES[1]) && req.query.teamId) || (!req.query.teamId && !req.query.gamePk && !req.query.src) ) {
      // load a sample encrypted HLS stream
      session.log('loading sample stream')
      options.resolution = VALID_RESOLUTIONS[0]
      streamURL = SAMPLE_STREAM_URL
      options.referer = 'https://hls-js.netlify.app/'
    } else {
      if ( req.query.resolution && (options.resolution == 'best') ) {
        options.resolution = VALID_RESOLUTIONS[1]
      } else {
        options.resolution = session.returnValidItem(req.query.resolution, VALID_RESOLUTIONS)
      }
      options.force_vod = req.query.force_vod || VALID_FORCE_VOD[0]

      options.inning_half = req.query.inning_half || VALID_INNING_HALF[0]
      options.inning_number = req.query.inning_number || VALID_INNING_NUMBER[0]
      options.skip = req.query.skip || VALID_SKIP[0]
      options.pad = req.query.pad || VALID_PAD[0]
      if ( options.pad != VALID_PAD[0] ) {
        // if pad is selected, pick a random number of times to repeat the last segment (between 1-3 hours)
        options.pad = Math.floor(Math.random() * (7200 / SECONDS_PER_SEGMENT)) + (3600 / SECONDS_PER_SEGMENT)
      }

      if ( req.query.src ) {
        streamURL = req.query.src
      } else {
        if ( req.query.gamePk ) {
          gamePk = req.query.gamePk
        } else if ( req.query.teamId ) {
          gamePk = await session.getGamePk(decodeURIComponent(req.query.teamId), req.query.date, req.query.game)
        }

        if ( !gamePk ) {
          session.log('failed to get gamePk : ' + req.url)
          res.end('')
        } else {
          session.debuglog('gamePk : ' + gamePk)
          streamURL = await session.getStreamURL(gamePk)
        }
      }
    }

    if (streamURL) {
      session.debuglog('using streamURL : ' + streamURL)

      if ( (options.inning_half != VALID_INNING_HALF[0]) || (options.inning_number != VALID_INNING_NUMBER[0]) || (options.skip != VALID_SKIP[0]) ) {
        if ( gamePk ) {
          options.gamePk = gamePk

          let skip_adjust = parseInt(req.query.skip_adjust) || DEFAULT_SKIP_ADJUST

          let skip_type = VALID_SKIP.indexOf(options.skip)

          if ( await session.getBroadcastStart(streamURL, gamePk) ) {
            await session.getSkipMarkers(gamePk, skip_type, options.inning_number, options.inning_half, skip_adjust)
          }
        }
      }

      if ( req.query.referer ) {
        options.referer = req.query.referer
        session.debuglog('sending referer : ' + options.referer)
      }

      getMasterPlaylist(streamURL, req, res, options)
    } else {
      session.log('failed to get streamURL : ' + req.url)
      res.end('')
    }
  } catch (e) {
    session.log('stream request error : ' + e.message)
    res.end('')
  }
})

// Store previous keys, for return without decoding
var prevKeys = {}
var getKey = function(url, headers, cb) {
  if ( (typeof prevKeys[url] !== 'undefined') && (typeof prevKeys[url].key !== 'undefined') ) {
    return cb(null, prevKeys[url].key)
  }

  if ( typeof prevKeys[url] === 'undefined' ) prevKeys[url] = {}

  session.debuglog('key request : ' + url)
  requestRetry(url, headers, function(err, response) {
    if (err) return cb(err)
    prevKeys[url].key = response.body
    cb(null, response.body)
  })
}

function getOriginFromURL(url) {
  let pathArray = url.split('/')
  return pathArray[0] + '//' + pathArray[2]
}

// Default respond function, for adjusting content-length and updating CORS headers
var respond = function(proxy, res, body) {
  delete proxy.headers['content-length']
  delete proxy.headers['transfer-encoding']
  delete proxy.headers['content-md5']
  delete proxy.headers['connection']
  delete proxy.headers['access-control-allow-credentials']

  proxy.headers['content-length'] = body.length
  proxy.headers['access-control-allow-origin'] = '*'

  res.writeHead(proxy.statusCode, proxy.headers)
  res.end(body)
}

// Retry request function, up to 2 times
var requestRetry = function(u, opts, cb) {
  var tries = 2
  var action = function() {
    session.streamVideo(u, opts, tries, function(err, res) {
      if (err) {
        if ( tries < 2 ) session.log('try ' + (3 - tries) + ' for ' + u)
        if (tries-- > 0) return setTimeout(action, 1000)
        return cb(err)
      }
      cb(err, res)
    })
  }

  action()
}


// Get the master playlist from the stream URL
function getMasterPlaylist(streamURL, req, res, options = {}) {
  session.debuglog('getMasterPlaylist of streamURL : ' + streamURL)
  var req = function () {
    var headers = {}
    var referer = false
    var referer_parameter = ''
    if ( options.referer ) {
      referer = decodeURIComponent(options.referer)
      headers.referer = referer
      headers.origin = getOriginFromURL(referer)
      session.debuglog('found stream referer  : ' + referer)
      referer_parameter = '&referer=' + encodeURIComponent(options.referer)
    }
    requestRetry(streamURL, headers, function(err, response) {
      if (err) return res.error(err)

      session.debuglog(response.body)

      var body = response.body.trim().split('\n')

      // check if HLS
      let hls_detected = false
      for (var i=0; i<body.length; i++) {
        if ( body[i] == '#EXTM3U' ) {
          session.debuglog('hls detected')
          hls_detected = true
          break
        } else if ( body[i] == '' ) {
          session.debuglog('skipping blank lines at beginning of file')
          continue
        } else {
          session.debuglog(body[i])
          break
        }
      }
      if ( !hls_detected ) {
        session.log('not a valid hls stream')
        return
      }

      let resolution = options.resolution || VALID_RESOLUTIONS[0]
      let force_vod = options.force_vod || VALID_FORCE_VOD[0]

      let inning_half = options.inning_half || VALID_INNING_HALF[0]
      let inning_number = options.inning_number || VALID_INNING_NUMBER[0]
      let skip = options.skip || VALID_SKIP[0]
      let pad = options.pad || VALID_PAD[0]
      let gamePk = options.gamePk || false

      if ( (inning_number > 0) && (inning_half == VALID_INNING_HALF[0]) ) {
        inning_half = VALID_INNING_HALF[1]
      }

      var content_protect = ''
      if ( session.protection.content_protect ) {
        content_protect = '&content_protect=' + session.protection.content_protect
      }

      // Some variables for controlling audio/video stream selection, if specified
      var video_track_matched = false
      var frame_rate = '29.97'
      if ( resolution !== VALID_RESOLUTIONS[0] ) {
        if ( resolution.slice(4) === '60' ) {
          frame_rate = '59.94'
        }
        resolution = resolution.slice(0, 3)
      }

      var segment_playlist = false
      var segment_found = false

      body = body
      .map(function(line) {
        let newurl = ''

        // Check if segment playlist instead of master
        if ( line.startsWith('#EXTINF:') ) {
          if ( !segment_playlist ) {
            session.debuglog('segment playlist instead of master')
            segment_playlist = true
          }
          segment_found = true
          return line
        } else if ( segment_found ) {
          segment_found = false
          return 'ts?url='+encodeURIComponent(url.resolve(streamURL, line.trim())) + content_protect + referer_parameter
        }

        // Omit subtitles
        /*if ( line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES') ) {
          return
        }
        if (line.indexOf(',SUBTITLES="subs"') > 0) {
          line = line.replace(',SUBTITLES="subs"', '')
        }*/

        // Omit keyframe tracks
        if (line.indexOf('#EXT-X-I-FRAME-STREAM-INF:') === 0) {
          return
        }

        // Parse video tracks to only include matching one, if specified
        if (line.indexOf('#EXT-X-STREAM-INF:BANDWIDTH=') === 0) {
          if ( resolution === VALID_RESOLUTIONS[0] ) {
            return line
          } else {
            if (line.indexOf(resolution+',FRAME-RATE='+frame_rate) > 0) {
              video_track_matched = true
              return line
            } else {
              return
            }
          }
        }

        // Skip key in archive master playlists
        if (line.indexOf('#EXT-X-SESSION-KEY:METHOD=AES-128') === 0) {
          return
        }

        // Handle subtitle tracks
        if ( line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES') ) {
          if ( line.match ) {
            //var parsed = line.match(/URI="([^"]+)"?$/)
            var parsed = line.match(',URI="([^"]+)"')
            if ( parsed[1] ) {
              newurl = 'playlist?url='+encodeURIComponent(url.resolve(streamURL, parsed[1].trim()))
              if ( inning_half != VALID_INNING_HALF[0] ) newurl += '&inning_half=' + inning_half
              if ( inning_number != VALID_INNING_NUMBER[0] ) newurl += '&inning_number=' + inning_number
              if ( skip != VALID_SKIP[0] ) newurl += '&skip=' + skip
              if ( pad != VALID_PAD[0] ) newurl += '&pad=' + pad
              if ( gamePk ) newurl += '&gamePk=' + gamePk
              if ( force_vod != VALID_FORCE_VOD[0] ) newurl += '&force_vod=on'
              newurl += content_protect + referer_parameter
              return line.replace(parsed[1],newurl)
            }
          }
        }

        if (line[0] === '#') {
          return line
        }

        if ( (resolution === VALID_RESOLUTIONS[0]) || (video_track_matched) ) {
          video_track_matched = false
          newurl = encodeURIComponent(url.resolve(streamURL, line.trim()))
          if ( inning_half != VALID_INNING_HALF[0] ) newurl += '&inning_half=' + inning_half
          if ( inning_number != VALID_INNING_NUMBER[0] ) newurl += '&inning_number=' + inning_number
          if ( skip != VALID_SKIP[0] ) newurl += '&skip=' + skip
          if ( pad != VALID_PAD[0] ) newurl += '&pad=' + pad
          if ( gamePk ) newurl += '&gamePk=' + gamePk
          if ( force_vod != VALID_FORCE_VOD[0] ) newurl += '&force_vod=on'
          newurl += content_protect + referer_parameter
          return 'playlist?url='+newurl
        }
      })
      .filter(function(line) {
        return line
      })
      .join('\n')+'\n'

      session.debuglog(body)
      respond(response, res, Buffer.from(body))
    })
  }

  return req()

  requestRetry(streamURL, {}, function(err, res) {
    if (err) return res.error(err)
    req()
  })
}

// Listen for playlist requests
app.get('/playlist', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('playlist', req, true)

  delete req.headers.host

  var u = req.query.url
  session.debuglog('playlist url : ' + u)

  var referer = false
  var referer_parameter = ''
  if ( req.query.referer ) {
    referer = decodeURIComponent(req.query.referer)
    session.debuglog('found playlist referer : ' + referer)
    referer_parameter = '&referer=' + encodeURIComponent(req.query.referer)
  }

  var force_vod = req.query.force_vod || VALID_FORCE_VOD[0]
  var inning_half = req.query.inning_half || VALID_INNING_HALF[0]
  var inning_number = req.query.inning_number || VALID_INNING_NUMBER[0]
  var skip = req.query.skip || VALID_SKIP[0]
  var pad = req.query.pad || VALID_PAD[0]
  var gamePk = req.query.gamePk || false

  var extension = 'ts'
  if (u.endsWith('_webVTT.m3u8') > 0) {
    extension = 'vtt'
  }

  var req = function () {
    var headers = {}
    if ( referer ) {
      headers.referer = referer
      headers.origin = getOriginFromURL(referer)
    }
    requestRetry(u, headers, function(err, response) {
      if (err) return res.error(err)

      //session.debuglog(response.body)

      var body = response.body.trim().split('\n')

      // check if HLS
      let hls_detected = false
      for (var i=0; i<body.length; i++) {
        if ( body[i] == '#EXTM3U' ) {
          session.debuglog('hls detected')
          hls_detected = true
          break
        } else if ( body[i] == '' ) {
          session.debuglog('skipping blank lines at beginning of file')
          continue
        } else {
          session.debuglog(body[i])
          break
        }
      }
      if ( !hls_detected ) {
        session.log('not a valid hls stream')
        return
      }

      var key
      var iv
      var skip_markers
      var skip_marker_index = 0
      var time_counter = 0.0
      var skip_next = false
      var discontinuity = false

      var content_protect = ''
      if ( session.protection.content_protect ) {
        content_protect = '&content_protect=' + session.protection.content_protect
      }

      if ( (gamePk) && ((inning_half != VALID_INNING_HALF[0]) || (inning_number != VALID_INNING_NUMBER[0]) || (skip != VALID_SKIP[0])) && (typeof session.temp_cache[gamePk] !== 'undefined') && (typeof session.temp_cache[gamePk].skip_markers !== 'undefined') ) {
        session.debuglog('pulling skip markers from temporary cache')
        skip_markers = session.temp_cache[gamePk].skip_markers
      } else {
        session.debuglog('not using skip markers from temporary cache')
      }

      body = body
      .map(function(line) {
        // Skip blank lines
        if (line.trim() == '') return null

        if ( skip_markers && skip_markers[skip_marker_index] ) {
          if ( skip_next ) {
            skip_next = false
            return null
          }

          if (line.indexOf('#EXTINF:') == 0) {
            time_counter += parseFloat(line.substring(8, line.length-1))
            session.debuglog('checking skip marker at ' + time_counter)

            while (skip_markers[skip_marker_index] && (skip_markers[skip_marker_index].break_end < time_counter)) {
              skip_marker_index++
            }
            if (skip_markers[skip_marker_index] && (time_counter >= skip_markers[skip_marker_index].break_start) && (time_counter < skip_markers[skip_marker_index].break_end)) {
              session.debuglog('skipping ' + time_counter)
              skip_next = true
              if ( discontinuity ) {
                return null
              } else {
                discontinuity = true
                return '#EXT-X-DISCONTINUITY'
              }
            } else {
              session.debuglog('keeping ' + time_counter)
              discontinuity = false
            }
          }
        }

        if (line.indexOf('-KEY:METHOD=AES-128') > 0) {
          var parsed = line.match(/URI="([^"]+)"(?:,IV=(.+))?$/)
          if ( parsed ) {
            if ( parsed[1].substr(0,4) == 'http' ) key = parsed[1]
            else key = url.resolve(u, parsed[1])
            if (parsed[2]) iv = parsed[2].slice(2).toLowerCase()
          }
          return null
        }

        if (line[0] === '#') return line

        if ( key ) return extension + '?url='+encodeURIComponent(url.resolve(u, line.trim()))+'&key='+encodeURIComponent(key)+'&iv='+encodeURIComponent(iv) + content_protect + referer_parameter
        else return extension + '?url='+encodeURIComponent(url.resolve(u, line.trim())) + content_protect + referer_parameter
      })
      .filter(function(line) {
        return line
      })
      .join('\n')+'\n'

      if ( pad != VALID_PAD[0] ) {
        let body_array = body.trim().split('\n')
        let last_segment_index = body_array.length-1
        if ( body_array[last_segment_index] == '#EXT-X-ENDLIST' ) {
          session.debuglog('padding archive stream with extra segments')
          last_segment_index--
          while ( !body_array[last_segment_index].startsWith('#EXTINF:' + SECONDS_PER_SEGMENT) ) {
            last_segment_index--
          }
          last_segment_inf = body_array[last_segment_index]
          last_segment = body_array[last_segment_index+1]
          let pad_lines = '#EXT-X-DISCONTINUITY' + '\n' + last_segment_inf + '\n' + last_segment + '\n'
          session.debuglog(pad_lines)
          for (i=0; i<pad; i++) {
            body += pad_lines
          }
          body += '#EXT-X-ENDLIST' + '\n'
        }
      }
      if ( force_vod != VALID_FORCE_VOD[0] ) body += '#EXT-X-ENDLIST' + '\n'
      session.debuglog(body)
      respond(response, res, Buffer.from(body))
    })
  }

  return req()

  requestRetry(u, {}, function(err, res) {
    if (err) return res.error(err)
    req()
  })
})

// Listen for ts requests (video segments) and decode them
app.get('/ts', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('ts', req, true)

  delete req.headers.host

  var u = req.query.url
  session.debuglog('ts url : ' + u)

  var headers = {encoding:null}

  if ( req.query.referer ) {
    session.debuglog('found segment referer : ' + req.query.referer)
    referer = decodeURIComponent(req.query.referer)
    headers.referer = referer
    headers.origin = getOriginFromURL(referer)
  }

  requestRetry(u, headers, function(err, response) {
    if (err) return res.error(err)
    if (!req.query.key) return respond(response, res, response.body)

    //var ku = url.resolve(manifest, req.query.key)
    var ku = req.query.key
    if ( ku.substr(0,4) != 'http' ) {
      var iv = Buffer.from(req.query.iv, 'hex')
      session.debuglog('iv : 0x'+req.query.iv)

      let key = Buffer.from(ku, "base64")

      var dc = crypto.createDecipheriv('aes-128-cbc', key, iv)
      var buffer = Buffer.concat([dc.update(response.body), dc.final()])

      respond(response, res, buffer)
    } else {
      getKey(ku, headers, function(err, key) {
        if (err) return res.error(err)

        var iv = Buffer.from(req.query.iv, 'hex')
        session.debuglog('iv : 0x'+req.query.iv)

        var dc = crypto.createDecipheriv('aes-128-cbc', key, iv)
        var buffer = Buffer.concat([dc.update(response.body), dc.final()])

        respond(response, res, buffer)
      })
    }
  })
})

// Listen for vtt (subtitle) requests
app.get('/vtt', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('vtt', req, true)

  delete req.headers.host

  var u = req.query.url
  session.debuglog('vtt url : ' + u)

  var referer = false
  var referer_parameter = ''
  if ( req.query.referer ) {
    referer = decodeURIComponent(req.query.referer)
    session.debuglog('found vtt referer : ' + referer)
    referer_parameter = '&referer=' + encodeURIComponent(req.query.referer)
  }

  var req = function () {
    var headers = {}
    if ( referer ) {
      headers.referer = referer
      headers.origin = getOriginFromURL(referer)
    }
    requestRetry(u, headers, function(err, response) {
      if (err) return res.error(err)

      //session.debuglog(response.body)

      var body = response.body
      session.debuglog(body)
      respond(response, res, Buffer.from(body))
    })
  }

  return req()

  requestRetry(u, {}, function(err, res) {
    if (err) return res.error(err)
    req()
  })
})

// Protect pages by password, or content by content_protect url parameter
async function protect(req, res) {
  if (argv.page_username && argv.page_password) {
    if ( !session.protection.content_protect || !req.query.content_protect || (req.query.content_protect != session.protection.content_protect) ) {
      if ( !session.protection.content_protect || !req.query.content_protect || !req.query.content_protect[0] || (req.query.content_protect[0] != session.protection.content_protect) ) {
        const reject = () => {
          res.setHeader('www-authenticate', 'Basic')
          res.error(401, ' Not Authorized')
          return false
        }

        const authorization = req.headers.authorization

        if(!authorization) {
          return reject()
        }

        const [username, password] = Buffer.from(authorization.replace('Basic ', ''), 'base64').toString().split(':')

        if(! (username === argv.page_username && password === argv.page_password)) {
          return reject()
        }
      }
    }
  }
  return true
}

// Server homepage, base URL
app.get('/', async function(req, res) {
  try {
    if ( ! (await protect(req, res)) ) return

    session.requestlog('homepage', req)

    let server = 'http://' + req.headers.host
    let multiview_server = server.replace(':' + session.data.port, ':' + session.data.multiviewPort)

    let gameDate = session.liveDate()
    let today = gameDate
    let yesterday = session.yesterdayDate()
    let todayUTCHours = session.getTodayUTCHours()
    let curDate = new Date()
    if ( req.query.date ) {
      if ( req.query.date == VALID_DATES[1] ) {
        gameDate = yesterday
      } else if ( req.query.date != VALID_DATES[0] ) {
        gameDate = req.query.date
      }
    } else {
      let utcHours = curDate.getUTCHours()
      if ( (utcHours >= todayUTCHours) && (utcHours < YESTERDAY_UTC_HOURS) ) {
        gameDate = yesterday
      }
    }

    var levels = session.getLevels()
    var level_labels = Object.keys(levels)
    var default_level = level_labels[0]
    var level = default_level
    if ( req.query.level ) {
      level = decodeURIComponent(req.query.level)
    }
    if ( typeof levels[level] === 'undefined' ) {
      level = default_level
    }

    var default_org = level_labels[level_labels.length-1]
    var org = default_org
    var team_ids = ''
    if ( req.query.org ) {
      org = decodeURIComponent(req.query.org)
      if ( typeof AFFILIATES[org] === 'undefined' ) {
        org = default_org
      } else {
        team_ids = AFFILIATES[org]
        level = default_org
      }
    }
    var level_ids  = levels[level]

    var cache_data = await session.getDayData(gameDate, level_ids, team_ids)

    var linkType = VALID_LINK_TYPES[0]
    if ( req.query.linkType ) {
      linkType = req.query.linkType
      session.setLinkType(linkType)
    }
    var controls = VALID_CONTROLS[0]
    if ( req.query.controls ) {
      controls = req.query.controls
    }
    var startFrom = VALID_START_FROM[0]
    if ( req.query.startFrom ) {
      startFrom = req.query.startFrom
    }
    var scores = VALID_SCORES[0]
    if ( req.query.scores ) {
      scores = req.query.scores
    }
    var resolution = VALID_RESOLUTIONS[0]
    if ( req.query.resolution ) {
      resolution = req.query.resolution
    }
    var force_vod = VALID_FORCE_VOD[0]
    if ( req.query.force_vod ) {
      force_vod = req.query.force_vod
    }
    var inning_half = VALID_INNING_HALF[0]
    if ( req.query.inning_half ) {
      inning_half = req.query.inning_half
    }
    var inning_number = VALID_INNING_NUMBER[0]
    if ( req.query.inning_number ) {
      inning_number = req.query.inning_number
    }
    var skip = VALID_SKIP[0]
    if ( req.query.skip ) {
      skip = req.query.skip
    }
    var skip_adjust = DEFAULT_SKIP_ADJUST
    if ( req.query.skip_adjust ) {
      skip_adjust = req.query.skip_adjust
    }
    var pad = VALID_PAD[0]
    if ( req.query.pad ) {
      pad = req.query.pad
    }

    var scan_mode = session.data.scan_mode
    if ( req.query.scan_mode && (req.query.scan_mode != session.data.scan_mode) ) {
      scan_mode = req.query.scan_mode
      session.setScanMode(req.query.scan_mode)
    }

    var content_protect = ''
    var content_protect_a = ''
    var content_protect_b = ''
    if ( session.protection.content_protect ) {
      content_protect = session.protection.content_protect
      content_protect_a = '?content_protect=' + content_protect
      content_protect_b = '&content_protect=' + content_protect
    }

    var body = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-type" content="text/html;charset=UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no"><title>' + appname + '</title><link rel="icon" href="favicon.svg' + content_protect_a + '"><style type="text/css">input[type=text],input[type=button]{-webkit-appearance:none;-webkit-border-radius:0}body{width:480px;color:lightgray;background-color:black;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:none}a{color:darkgray}button{color:lightgray;background-color:black}button.default{color:black;background-color:lightgray}table{width:100%;pad}table,th,td{border:1px solid darkgray;border-collapse:collapse}th,td{padding:5px}.tinytext,textarea,input[type="number"]{font-size:.8em}textarea{width:380px}'

    // Tooltip CSS
    body += '.tooltip{position:relative;display:inline-block;border-bottom: 1px dotted gray;}.tooltip .tooltiptext{font-size:.8em;visibility:hidden;width:360px;background-color:gray;color:white;text-align:left;padding:5px;border-radius:6px;position:absolute;z-index:1;top:100%;left:75%;margin-left:-30px;}.tooltip:hover .tooltiptext{visibility:visible;}'

    body += '</style><script type="text/javascript">' + "\n";

    // Define option variables in page
    body += 'var date="' + gameDate + '";var level="' + level + '";var org="' + org + '";var resolution="' + resolution + '";var force_vod="' + force_vod + '";var inning_half="' + inning_half + '";var inning_number="' + inning_number + '";var skip="' + skip + '";var skip_adjust="' + skip_adjust + '";var pad="' + pad + '";var linkType="' + linkType + '";var startFrom="' + startFrom + '";var scores="' + scores + '";var controls="' + controls + '";var scan_mode="' + scan_mode + '";var content_protect="' + content_protect + '";' + "\n"

    // Reload function, called after options change
    body += 'var defaultDate="' + today + '";var curDate=new Date();var utcHours=curDate.getUTCHours();if ((utcHours >= ' + todayUTCHours + ') && (utcHours < ' + YESTERDAY_UTC_HOURS + ')){defaultDate="' + yesterday + '"}function reload(){var newurl="/?";if (date != defaultDate){var urldate=date;if (date == "' + today + '"){urldate="today"}else if (date == "' + yesterday + '"){urldate="yesterday"}newurl+="date="+urldate+"&"}if (level != "' + default_level + '"){newurl+="level="+encodeURIComponent(level)+"&"}if (org != "All"){newurl+="org="+encodeURIComponent(org)+"&"}if (resolution != "' + VALID_RESOLUTIONS[0] + '"){newurl+="resolution="+resolution+"&"}if (linkType=="' + VALID_LINK_TYPES[1] + '"){if (force_vod != "' + VALID_FORCE_VOD[0] + '"){newurl+="force_vod="+force_vod+"&"}}if (inning_half != "' + VALID_INNING_HALF[0] + '"){newurl+="inning_half="+inning_half+"&"}if (inning_number != "' + VALID_INNING_NUMBER[0] + '"){newurl+="inning_number="+inning_number+"&"}if (skip != "' + VALID_SKIP[0] + '"){newurl+="skip="+skip+"&";if (skip_adjust != "' + DEFAULT_SKIP_ADJUST + '"){newurl+="skip_adjust="+skip_adjust+"&"}}if (pad != "' + VALID_PAD[0] + '"){newurl+="pad="+pad+"&";}if (linkType != "' + VALID_LINK_TYPES[0] + '"){newurl+="linkType="+linkType+"&"}if (linkType=="' + VALID_LINK_TYPES[0] + '"){if (controls != "' + VALID_CONTROLS[0] + '"){newurl+="controls="+controls+"&"}if (startFrom != "' + VALID_START_FROM[0] + '"){newurl+="startFrom="+startFrom+"&"}}if (scores != "' + VALID_SCORES[0] + '"){newurl+="scores="+scores+"&"}if (scan_mode != "' + session.data.scan_mode + '"){newurl+="scan_mode="+scan_mode+"&"}if (content_protect != ""){newurl+="content_protect="+content_protect+"&"}window.location=newurl.substring(0,newurl.length-1)}' + "\n"

    // Ajax function for multiview and highlights
    body += 'function makeGETRequest(url, callback){var request=new XMLHttpRequest();request.onreadystatechange=function(){if (request.readyState==4 && request.status==200){callback(request.responseText)}};request.open("GET", url);request.send();}' + "\n"

    // Multiview functions
    body += 'function parsemultiviewresponse(responsetext){if (responsetext == "started"){setTimeout(function(){document.getElementById("startmultiview").innerHTML="Restart";document.getElementById("stopmultiview").innerHTML="Stop"},15000)}else if (responsetext == "stopped"){setTimeout(function(){document.getElementById("stopmultiview").innerHTML="Stopped";document.getElementById("startmultiview").innerHTML="Start"},3000)}else{alert(responsetext)}}function addmultiview(e){for(var i=1;i<=4;i++){var valuefound = false;var oldvalue="";var newvalue=e.value;if(!e.checked){oldvalue=e.value;newvalue=""}if (document.getElementById("multiview" + i).value == oldvalue){document.getElementById("multiview" + i).value=newvalue;valuefound=true;break}}if(e.checked && !valuefound){e.checked=false}}function startmultiview(e){var count=0;var getstr="";for(var i=1;i<=4;i++){if (document.getElementById("multiview"+i).value != ""){count++;getstr+="streams="+encodeURIComponent(document.getElementById("multiview"+i).value)+"&sync="+encodeURIComponent(document.getElementById("sync"+i).value)+"&"}}if((count >= 1) && (count <= 4)){if (document.getElementById("faster").checked){getstr+="faster=true&dvr=true&"}else if (document.getElementById("dvr").checked){getstr+="dvr=true&"}if (document.getElementById("reencode").checked){getstr+="reencode=true&"}if (document.getElementById("audio_url").value != ""){getstr+="audio_url="+encodeURIComponent(document.getElementById("audio_url").value)+"&";if (document.getElementById("audio_url_seek").value != "0"){getstr+="audio_url_seek="+encodeURIComponent(document.getElementById("audio_url_seek").value)}}e.innerHTML="starting...";makeGETRequest("/multiview?"+getstr, parsemultiviewresponse)}else{alert("Multiview requires between 1-4 streams to be selected")}return false}function stopmultiview(e){e.innerHTML="stopping...";makeGETRequest("/multiview", parsemultiviewresponse);return false}' + "\n"

    // Function to switch URLs to stream URLs, where necessary
    body += 'function stream_substitution(url){return url.replace(/\\/([a-zA-Z]+\.html)/,"/stream.m3u8")}' + "\n"

    // Adds touch capability to hover tooltips
    body += 'document.addEventListener("touchstart", function() {}, true);' + "\n"

		body += '</script></head><body><h1>' + appname + '</h1>' + "\n"

    body += '<p><span class="tooltip tinytext">Touch or hover over an option name for more details</span></p>' + "\n"

    todayUTCHours -= 4
    body += '<p><span class="tooltip">Date<span class="tooltiptext">"today" lasts until ' + todayUTCHours + ' AM EST. Home page will default to yesterday between ' + todayUTCHours + ' AM - ' + (YESTERDAY_UTC_HOURS - 4) + ' AM EST.</span></span>: <input type="date" id="gameDate" value="' + gameDate + '"/> '
    for (var i = 0; i < VALID_DATES.length; i++) {
      body += '<button '
      if ( ((VALID_DATES[i] == VALID_DATES[0]) && (gameDate == today)) || ((VALID_DATES[i] == VALID_DATES[1]) && (gameDate == yesterday)) ) body += 'class="default" '
      body += 'onclick="date=\'' + VALID_DATES[i] + '\';reload()">' + VALID_DATES[i] + '</button> '
    }
    let cache_label = gameDate + '.' + level_ids
    if ( org != default_org ) cache_label += '.' + team_ids
    body += '</p>' + "\n" + '<p><span class="tinytext">Updated ' + session.getCacheUpdatedDate(cache_label) + '</span></p>' + "\n"

    body += '<p><span class="tooltip">Level<span class="tooltiptext">Minor league level</span></span>: '
    for (const [key, value] of Object.entries(levels)) {
      body += '<button '
      if ( level == key ) body += 'class="default" '
      body += 'onclick="org=\'' + default_org + '\';level=\'' + key + '\';reload()">' + key + '</button> '
    }

    body += ' or <span class="tooltip">Org<span class="tooltiptext">Major league parent organization</span></span>: '
    body += '<select id="org" onchange="level=\'' + default_org + '\';org=this.value;reload()">'
    body += '<option value="' + default_org + '">' + default_org + '</option>'
    for (const [key, value] of Object.entries(AFFILIATES)) {
      body += '<option value="' + key + '"'
      if ( org == key ) body += ' selected'
      body += '>' + key + '</option> '
    }
    body += '</select></p>' + "\n"

    body += '<p><span class="tooltip">Link Type<span class="tooltiptext">Embed will play in your browser (with AirPlay support), Stream will give you a stream URL to open directly in media players like Kodi or VLC, Chromecast is a desktop browser-based casting site, and Advanced will play in your desktop browser with some extra tools and debugging information (Advanced may require you to disable mixed content blocking in your browser).<br><br>NOTE: Chromecast may not be able to resolve local domain names; if so, you can simply access this page using an IP address instead.</span></span>: '
    for (var i = 0; i < VALID_LINK_TYPES.length; i++) {
      body += '<button '
      if ( linkType == VALID_LINK_TYPES[i] ) body += 'class="default" '
      body += 'onclick="linkType=\'' + VALID_LINK_TYPES[i] + '\';reload()">' + VALID_LINK_TYPES[i] + '</button> '
    }
    body += '</p>' + "\n"

    if ( linkType == VALID_LINK_TYPES[0] ) {
      body += '<p><span class="tooltip">Video Controls<span class="tooltiptext">Choose whether to show or hide controls on the embedded video page. Helpful to avoid timeline spoilers.</span></span>: '
      for (var i = 0; i < VALID_CONTROLS.length; i++) {
        body += '<button '
        if ( controls == VALID_CONTROLS[i] ) body += 'class="default" '
        body += 'onclick="controls=\'' + VALID_CONTROLS[i] + '\';reload()">' + VALID_CONTROLS[i] + '</button> '
      }
      body += '</p>' + "\n"

      body += '<p><span class="tooltip">Start From<span class="tooltiptext">For the embedded player only: Beginning will start playback at the beginning of the stream (may be 1 hour before game time for live games), and Live will start at the live point (if the event is live -- archive games should always start at the beginning). You can still seek anywhere.</span></span>: '
      for (var i = 0; i < VALID_START_FROM.length; i++) {
        body += '<button '
        if ( startFrom == VALID_START_FROM[i] ) body += 'class="default" '
        body += 'onclick="startFrom=\'' + VALID_START_FROM[i] + '\';reload()">' + VALID_START_FROM[i] + '</button> '
      }
      body += 'or '
    }

    body += '<span class="tooltip">Inning<span class="tooltiptext">For video streams only: choose the inning to start with (and the score to display, if applicable). Inning number is relative -- for example, selecting inning 7 here will show inning 7 for scheduled 9 inning games, but inning 5 for scheduled 7 inning games, for example. If an inning number is specified, seeking to an earlier point will not be possible. Default is the beginning of the stream. Also does not work for suspended/resumed games.</span></span>: '
    body += '<select id="inning_half" onchange="inning_half=this.value;reload()">'
    for (var i = 0; i < VALID_INNING_HALF.length; i++) {
      body += '<option value="' + VALID_INNING_HALF[i] + '"'
      if ( inning_half == VALID_INNING_HALF[i] ) body += ' selected'
      body += '>' + VALID_INNING_HALF[i] + '</option> '
    }
    body += '</select>' + "\n"

    body += ' '
    body += '<select id="inning_number" onchange="inning_number=this.value;reload()">'
    for (var i = 0; i < VALID_INNING_NUMBER.length; i++) {
      body += '<option value="' + VALID_INNING_NUMBER[i] + '"'
      if ( inning_number == VALID_INNING_NUMBER[i] ) body += ' selected'
      body += '>' + VALID_INNING_NUMBER[i] + '</option> '
    }
    body += '</select>'
    body += '</p>' + "\n"

    body += '<p><span class="tooltip">Scores<span class="tooltiptext">Choose whether to show scores on this web page.</span></span>: '
    for (var i = 0; i < VALID_SCORES.length; i++) {
      body += '<button '
      if ( scores == VALID_SCORES[i] ) body += 'class="default" '
      body += 'onclick="scores=\'' + VALID_SCORES[i] + '\';reload()">' + VALID_SCORES[i] + '</button> '
    }
    body += '</p>' + "\n"

    body += "<p><table>" + "\n"

    // Rename some parameters before display links
    var mediaType = 'MiLBTV'

    let link = linkType.toLowerCase() + '.html'
    if ( linkType == VALID_LINK_TYPES[1] ) {
      link = linkType.toLowerCase() + '.m3u8'
    } else {
      force_vod = VALID_FORCE_VOD[0]
    }
    var thislink = '/' + link

    for (var j = 0; j < cache_data.dates[0].games.length; j++) {
      let league = cache_data.dates[0].games[j].teams['home'].team.sport.name + ' ' + cache_data.dates[0].games[j].teams['home'].team.league.name

      let awayteam = cache_data.dates[0].games[j].teams['away'].team.shortName + ' (' + session.getParent(cache_data.dates[0].games[j].teams['away'].team.parentOrgName) + ')'
      let hometeam = cache_data.dates[0].games[j].teams['home'].team.shortName + ' (' + session.getParent(cache_data.dates[0].games[j].teams['home'].team.parentOrgName) + ')'

      let teams = league + ':<br/><span class="tooltip">' + awayteam + '<span class="tooltiptext">Team ID: ' + cache_data.dates[0].games[j].teams['away'].team.id + '</span></span> @ <span class="tooltip">' + hometeam + '<span class="tooltiptext">Team ID: ' + cache_data.dates[0].games[j].teams['home'].team.id + '</span></span>'
      let pitchers = ""
      let state = "<br/>"

      if ( cache_data.dates[0].games[j].status.startTimeTBD == true ) {
        state += "Time TBD"
      } else {
        let startTime = new Date(cache_data.dates[0].games[j].gameDate)
        state += startTime.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })
      }

      var abstractGameState = cache_data.dates[0].games[j].status.abstractGameState
      var detailedState = cache_data.dates[0].games[j].status.detailedState

      var scheduledInnings = '9'
      if ( cache_data.dates[0].games[j].linescore && cache_data.dates[0].games[j].linescore.scheduledInnings ) {
        scheduledInnings = cache_data.dates[0].games[j].linescore.scheduledInnings
      }
      var relative_inning = (inning_number - (9 - scheduledInnings))
      relative_inning = relative_inning < 0 ? 0 : relative_inning
      if ( (scores == VALID_SCORES[1]) && (cache_data.dates[0].games[j].gameUtils.isLive || cache_data.dates[0].games[j].gameUtils.isFinal) && !cache_data.dates[0].games[j].gameUtils.isCancelled && !cache_data.dates[0].games[j].gameUtils.isPostponed ) {
        let awayscore = ''
        let homescore = ''
        if ( (inning_number != VALID_INNING_NUMBER[0]) && cache_data.dates[0].games[j].linescore && cache_data.dates[0].games[j].linescore.innings ) {
          awayscore = 0
          homescore = 0
          let display_inning = ''
          for (var k = 0; k < cache_data.dates[0].games[j].linescore.innings.length; k++) {
            if ( cache_data.dates[0].games[j].linescore.innings[k] ) {
              if ( (cache_data.dates[0].games[j].linescore.innings[k].num < relative_inning) ) {
                display_inning = 'T' + cache_data.dates[0].games[j].linescore.innings[k].num
                if ( typeof cache_data.dates[0].games[j].linescore.innings[k].away.runs !== 'undefined' ) awayscore += cache_data.dates[0].games[j].linescore.innings[k].away.runs
                if ( typeof cache_data.dates[0].games[j].linescore.innings[k].home.runs !== 'undefined' ) {
                  display_inning = 'B' + cache_data.dates[0].games[j].linescore.innings[k].num
                  homescore += cache_data.dates[0].games[j].linescore.innings[k].home.runs
                  if ( cache_data.dates[0].games[j].linescore.innings[k+1] ) {
                    display_inning = 'T' + (cache_data.dates[0].games[j].linescore.innings[k].num + 1)
                  }
                }
              } else if ( (inning_half == VALID_INNING_HALF[2]) && (cache_data.dates[0].games[j].linescore.innings[k].num == relative_inning) ) {
                if ( typeof cache_data.dates[0].games[j].linescore.innings[k].away.runs !== 'undefined' ) {
                  display_inning = 'B' + cache_data.dates[0].games[j].linescore.innings[k].num
                  awayscore += cache_data.dates[0].games[j].linescore.innings[k].away.runs
                }
              } else {
                break
              }
            } else {
              break
            }
          }
          if ( display_inning != '' ) {
            state = "<br/>" + display_inning
          }
        } else {
          awayscore = cache_data.dates[0].games[j].teams['away'].score
          homescore = cache_data.dates[0].games[j].teams['home'].score
          if ( cache_data.dates[0].games[j].gameUtils.isLive && !cache_data.dates[0].games[j].gameUtils.isFinal ) {
            state = "<br/>" + cache_data.dates[0].games[j].linescore.inningHalf.substr(0,1) + cache_data.dates[0].games[j].linescore.currentInning
          } else if ( cache_data.dates[0].games[j].gameUtils.isFinal ) {
            state = "<br/>" + detailedState
          }
          if ( cache_data.dates[0].games[j].flags.perfectGame == true ) {
            state += "<br/>Perfect Game"
          } else if ( cache_data.dates[0].games[j].flags.noHitter == true ) {
            state += "<br/>No-Hitter"
          }
        }
        teams = awayteam + " " + awayscore + " @ " + hometeam + " " + homescore
      } else if ( cache_data.dates[0].games[j].gameUtils.isCancelled || cache_data.dates[0].games[j].gameUtils.isPostponed || cache_data.dates[0].games[j].gameUtils.isSuspended ) {
        state = "<br/>" + detailedState
      } else if ( cache_data.dates[0].games[j].gameUtils.isDelayed ) {
        state += "<br/>" + detailedState
      }

      if ( cache_data.dates[0].games[j].doubleHeader != 'N'  ) {
        state += "<br/>Game " + cache_data.dates[0].games[j].gameNumber
      }
      if ( cache_data.dates[0].games[j].description ) {
        state += "<br/>" + cache_data.dates[0].games[j].description
      }
      if ( scheduledInnings != '9' ) {
        state += "<br/>" + cache_data.dates[0].games[j].linescore.scheduledInnings + " inning game"
      }
      var resumeStatus = false
      if ( cache_data.dates[0].games[j].resumeGameDate || cache_data.dates[0].games[j].resumedFromDate ) {
        resumeStatus = true
        state += '<br/>Resum'
        let resumeDate
        if ( cache_data.dates[0].games[j].resumeGameDate ) {
          resumeDate = new Date(cache_data.dates[0].games[j].resumeDate)
          state += 'ing on'
        } else {
          resumeDate = new Date(cache_data.dates[0].games[j].resumedFrom)
          state += 'ed from'
        }
        state += ' ' + resumeDate.toLocaleString('default', { month: 'long', day: 'numeric' })
      }

      if ( (cache_data.dates[0].games[j].teams['away'].probablePitcher && cache_data.dates[0].games[j].teams['away'].probablePitcher.fullName) || (cache_data.dates[0].games[j].teams['home'].probablePitcher && cache_data.dates[0].games[j].teams['home'].probablePitcher.fullName) ) {
        pitchers = "<br/>"
        if ( cache_data.dates[0].games[j].teams['away'].probablePitcher && cache_data.dates[0].games[j].teams['away'].probablePitcher.fullName ) {
          pitchers += cache_data.dates[0].games[j].teams['away'].probablePitcher.fullName
        } else {
          pitchers += 'TBD'
        }
        pitchers += ' vs '
        if ( cache_data.dates[0].games[j].teams['home'].probablePitcher && cache_data.dates[0].games[j].teams['home'].probablePitcher.fullName ) {
          pitchers += cache_data.dates[0].games[j].teams['home'].probablePitcher.fullName
        } else {
          pitchers += 'TBD'
        }
      }

      body += "<tr><td>" + teams + pitchers + state + "</td>"

      if ( ((typeof cache_data.dates[0].games[j].content.media) == 'undefined') || ((typeof cache_data.dates[0].games[j].content.media.epg) == 'undefined') ) {
        body += "<td>"
        let message = 'N/A'
        if ( typeof cache_data.dates[0].games[j].broadcasts !== 'undefined' ) {
          for (var k = 0; k < cache_data.dates[0].games[j].broadcasts.length; k++) {
            if ( cache_data.dates[0].games[j].broadcasts[k].name == 'MiLB.TV' ) {
              message = mediaType
              break
            }
          }
        }
        body += message
        body += "</td>"
      } else {
        body += "<td>"
        for (var k = 0; k < cache_data.dates[0].games[j].content.media.epg.length; k++) {
          let epgTitle = cache_data.dates[0].games[j].content.media.epg[k].title
          if ( epgTitle == mediaType ) {
            for (var x = 0; x < cache_data.dates[0].games[j].content.media.epg[k].items.length; x++) {
              let station = cache_data.dates[0].games[j].content.media.epg[k].title
              if ( (cache_data.dates[0].games[j].content.media.epg[k].items[x].mediaState == 'MEDIA_ON') || (cache_data.dates[0].games[j].content.media.epg[k].items[x].mediaState == 'MEDIA_ARCHIVE') ) {
                let gamePk = cache_data.dates[0].games[j].gamePk
                let querystring
                querystring = '?gamePk=' + gamePk
                let multiviewquerystring = querystring + '&resolution=' + DEFAULT_MULTIVIEW_RESOLUTION
                if ( resolution != VALID_RESOLUTIONS[0] ) querystring += '&resolution=' + resolution
                if ( linkType == VALID_LINK_TYPES[0] ) {
                  if ( startFrom != VALID_START_FROM[0] ) querystring += '&startFrom=' + startFrom
                  if ( controls != VALID_CONTROLS[0] ) querystring += '&controls=' + controls
                }
                if ( resumeStatus == false ) {
                  if ( inning_half != VALID_INNING_HALF[0] ) querystring += '&inning_half=' + inning_half
                  if ( inning_number != VALID_INNING_NUMBER[0] ) querystring += '&inning_number=' + relative_inning
                  if ( skip != VALID_SKIP[0] ) querystring += '&skip=' + skip
                  if ( skip_adjust != DEFAULT_SKIP_ADJUST ) querystring += '&skip_adjust=' + skip_adjust
                }
                if ( pad != VALID_PAD[0] ) querystring += '&pad=' + pad
                if ( linkType == VALID_LINK_TYPES[1] ) {
                  if ( cache_data.dates[0].games[j].content.media.epg[k].items[x].mediaState == 'MEDIA_ON' ) {
                    if ( force_vod != VALID_FORCE_VOD[0] ) querystring += '&force_vod=' + force_vod
                  }
                }
                querystring += content_protect_b
                multiviewquerystring += content_protect_b
                body += '<a href="' + thislink + querystring + '">' + station + '</a>'
                body += '<input type="checkbox" value="' + server + '/stream.m3u8' + multiviewquerystring + '" onclick="addmultiview(this)">'
              } else {
                body += station
                break
              }
            }
            break
          }
        }
        body += "</td>"
        body += "</tr>" + "\n"
      }
    }
    body += "</table></p>" + "\n"

    body += '<p><span class="tooltip">Video<span class="tooltiptext">For video streams only: you can manually specifiy a video track (resolution) to use. Adaptive will let your client choose. 720p60 is the best quality.</span></span>: '
    for (var i = 0; i < VALID_RESOLUTIONS.length; i++) {
      body += '<button '
      if ( resolution == VALID_RESOLUTIONS[i] ) body += 'class="default" '
      body += 'onclick="resolution=\'' + VALID_RESOLUTIONS[i] + '\';reload()">' + VALID_RESOLUTIONS[i]
      if ( DISPLAY_BANDWIDTHS[i] != '' ) {
        body += '<br/><span class="tinytext">' + DISPLAY_BANDWIDTHS[i] + '</span>'
      }
      body += '</button> '
    }
    body += '</p>' + "\n"

    body += '<table><tr><td><table><tr><td>1</td><td>2</tr><tr><td>3</td><td>4</td></tr></table><td><span class="tooltip">Multiview / Alternate Audio / Sync<span class="tooltiptext">For video streams only: create a new live stream combining 1-4 separate video streams, using the layout shown at left (if more than 1 video stream is selected). Check the boxes next to feeds above to add/remove them, then click "Start" when ready, "Stop" when done watching, or "Restart" to stop and start with the currently selected streams. May take up to 15 seconds after starting before it is ready to play.<br/><br/>No video scaling is performed: defaults to 540p video for each stream, which can combine to make one 1080p stream. Audio defaults to English (TV) audio. If you specify a different audio track instead, you can use the box after each URL below to adjust the sync in seconds (use positive values if audio is early and the audio stream needs to be padded with silence at the beginning to line up with the video; negative values if audio is late, and audio needs to be trimmed from the beginning.)<br/><br/>TIP #1: You can enter just 1 video stream here, at any resolution, to take advantage of the audio sync or alternate audio features without using multiview -- a single video stream will not be re-encoded and will be presented at its full resolution.<br/><br/>TIP #2: You can also manually enter streams from other sources like <a href="https://www.npmjs.com/package/mlbserver" target="_blank">mlbserver</a> in the boxes below. Make sure any manually entered streams have the desired resolution.<br/><br/>WARNING #1: if the milbserver process dies or restarts while multiview is active, the ffmpeg encoding process will be orphaned and must be killed manually.<br/><br/>WARNING #2: If you did not specify a hardware encoder for ffmpeg on the command line, this will use your server CPU for encoding. Either way, your system may not be able to keep up with processing 4 video streams at once. Try fewer streams if you have perisistent trouble.</span></span>: <a id="startmultiview" href="" onclick="startmultiview(this);return false">Start'
    if ( ffmpeg_status ) body += 'ed'
    body += '</a> | <a id="stopmultiview" href="" onclick="stopmultiview(this);return false">Stop'
    if ( !ffmpeg_status ) body += 'ped'
    body += '</a><br/>' + "\n"
    body += '<span class="tinytext">(check boxes next to games to add, then click "Start";<br/>must click "Stop" link above when done, or manually kill ffmpeg)</span></td></tr><tr><td colspan="2">' + "\n"
    for (var i=1; i<=4; i++) {
      body += i + ': <textarea id="multiview' + i + '" rows=2 cols=60 oninput="this.value=stream_substitution(this.value)"></textarea>'
      body += '<input type="number" id="sync' + i + '" value="0.0" step=".1" style="vertical-align:top;font-size:.8em;width:3em"/>'
      body += '<br/>' + "\n"
    }
    body += '<input type="checkbox" id="dvr"/> <span class="tooltip">DVR: allow pausing/seeking multiview<span class="tooltiptext">If this is enabled, it will use more disk space but you will be able to pause and seek in the multiview stream. Not necessary if you are strictly watching live.</span></span><br/>' + "\n"
    body += '<input type="checkbox" id="faster" onchange="if (this.checked){document.getElementById(\'dvr\').checked=true}"/> <span class="tooltip">Encode faster than real-time<span class="tooltiptext">Implies DVR. Not necessary for live streams (which are only delivered in real-time), but if you want to seek ahead in archive streams using multiview, you may want to enable this. WARNING: ffmpeg may approach 100% CPU usage if you use this while combining multiple archive video streams in multiview.</span></span><br/>' + "\n"
    body += '<input type="checkbox" id="reencode"/> <span class="tooltip">Re-encode all audio<span class="tooltiptext">Uses more CPU. Generally only necessary if you need the multiview stream to continue after one of the individual streams has ended. (Any streams with sync adjustments above will automatically be re-encoded, regardless of this setting.)</span></span><br/>' + "\n"
    body += '<hr><span class="tooltip">Alternate audio URL and sync<span class="tooltiptext">Optional: you can also include a separate audio-only URL as an additional alternate audio track. This is useful if you want to pair the road radio feed with a national TV broadcast (which only includes home radio feeds by default). Archive games will likely require a very large negative sync value, as the radio broadcasts may not be trimmed like the video archives.</span></span>:<br/><textarea id="audio_url" rows=2 cols=60 oninput="this.value=stream_substitution(this.value)"></textarea><input id="audio_url_seek" type="number" value="0" style="vertical-align:top;font-size:.8em;width:4em"/>'
    body += '<hr>Watch: <a href="/embed.html?src=' + encodeURIComponent(multiview_server + multiview_url_path) + '">Embed</a> | <a href="' + multiview_server + multiview_url_path + '">Stream</a> | <a href="/chromecast.html?src=' + encodeURIComponent(multiview_server + multiview_url_path) + '">Chromecast</a> | <a href="/advanced.html?src=' + encodeURIComponent(multiview_server + multiview_url_path) + '">Advanced</a><br/><span class="tinytext">Download: <a href="/kodi.strm?src=' + encodeURIComponent(multiview_server + multiview_url_path) + '">Kodi STRM file</a> (<a href="/kodi.strm?version=18&src=' + encodeURIComponent(multiview_server + multiview_url_path) + '">Leia/18</a>)</span>'
    body += '</td></tr></table><br/>' + "\n"

    body += '<p><span class="tooltip">Skip<span class="tooltiptext">For video streams only (use the video "none" option above to apply it to audio streams): you can remove breaks, idle time, or non-action pitches from the stream (useful to make your own "condensed games").<br/><br/>NOTE: skip timings are only generated when the stream is loaded -- so for live games, it will only skip up to the time you loaded the stream. Also does not work for suspended/resumed games.</span></span>: '
    for (var i = 0; i < VALID_SKIP.length; i++) {
      body += '<button '
      if ( skip == VALID_SKIP[i] ) body += 'class="default" '
      body += 'onclick="skip=\'' + VALID_SKIP[i] + '\';reload()">' + VALID_SKIP[i] + '</button> '
    }
    body += ' <span class="tooltip">Skip Adjust<span class="tooltiptext">Seconds to adjust the skip time video segments, if necessary. Try a negative number if the plays are ending before the video segments begin; use a positive number if the video segments are ending before the play happens.</span></span>: <input type="number" id="skip_adjust" value="' + skip_adjust + '" step="5" onchange="setTimeout(function(){skip_adjust=document.getElementById(\'skip_adjust\').value;reload()},750)" onblur="skip_adjust=this.value;reload()" style="vertical-align:top;font-size:.8em;width:3em"/>'
    body += '</p>' + "\n"

    body += '<p><span class="tooltip">Pad<span class="tooltiptext">You can pad archive streams with random extra time at the end, to help conceal timeline spoilers.</span></span>: '
    for (var i = 0; i < VALID_PAD.length; i++) {
      body += '<button '
      if ( pad == VALID_PAD[i] ) body += 'class="default" '
      body += 'onclick="pad=\'' + VALID_PAD[i] + '\';reload()">' + VALID_PAD[i] + '</button> '
    }
    body += '</p>' + "\n"

    if ( (linkType == VALID_LINK_TYPES[1]) && (gameDate == today) ) {
      body += '<p><span class="tooltip">Force VOD<span class="tooltiptext">For streams only: if your client does not support seeking in milbserver live streams, turning this on will make the stream look like a VOD stream instead, allowing the client to start at the beginning and allowing the user to seek within it. You will need to reload the stream to watch/view past the current time, though.</span></span>: '
      for (var i = 0; i < VALID_FORCE_VOD.length; i++) {
        body += '<button '
        if ( force_vod == VALID_FORCE_VOD[i] ) body += 'class="default" '
        body += 'onclick="force_vod=\'' + VALID_FORCE_VOD[i] + '\';reload()">' + VALID_FORCE_VOD[i] + '</button> '
      }
      body += '<span class="tinytext">(if client does not support seeking in live streams)</span></p>' + "\n"
    }

    body += '<table><tr><td>' + "\n"

    body += '<p><span class="tooltip">Live Channel Playlist and XMLTV Guide<span class="tooltiptext">Allows you to generate a M3U playlist of channels, and an XML file of guide listings for those channels, to import into TV/DVR/PVR software like Tvheadend or Jellyfin.<br/><br/>NOTE: May be helpful to specify a resolution above.</span></span>:</p>' + "\n"

    body += '<p><span class="tooltip">Scan Mode<span class="tooltiptext">During setup, some TV/DVR/PVR software will attempt to load all stream URLs. Turning Scan Mode ON will return a sample stream for all stream requests, thus satisfying that software without overloading milbserver or excluding streams which aren\'t currently live. Once the channels are set up, turning Scan Mode OFF will restore normal stream behavior.<br/><br/>WARNING: Be sure your TV/DVR/PVR software doesn\'t periodically scan all channels automatically or you might overload milbserver.</span></span>: '
    for (var i = 0; i < VALID_SCAN_MODES.length; i++) {
      body += '<button '
      if ( scan_mode == VALID_SCAN_MODES[i] ) body += 'class="default" '
      body += 'onclick="scan_mode=\'' + VALID_SCAN_MODES[i] + '\';reload()">' + VALID_SCAN_MODES[i] + '</button> '
    }
    body += ' <span class="tinytext">(ON plays sample for all stream requests)</span></p>' + "\n"

    if ( !req.query.resolution ) {
      resolution = 'best'
    }

    body += '<p>All: <a href="/channels.m3u?resolution=' + resolution + content_protect_b + '">channels.m3u</a> and <a href="/guide.xml' + content_protect_a + '">guide.xml</a></p>' + "\n"

    body += '<p><span class="tooltip">By org<span class="tooltiptext">Including an organization will include all of its affiliates\' games. Organization names are listed in the drop-down menu near the top of this page.</span></span>: <a href="/channels.m3u?resolution=' + resolution + '&includeOrgs=Angels,Blue Jays' + content_protect_b + '">channels.m3u</a> and <a href="/guide.xml?includeOrgs=Angels,Blue Jays' + content_protect_b + '">guide.xml</a></p>' + "\n"

    body += '<p><span class="tooltip">By team<span class="tooltiptext">Including a team id will include that team\'s games. Click or tap on a team name in the schedule table above to see its id number.</span></span>: <a href="/channels.m3u?resolution=' + resolution + '&includeTeams=342,422' + content_protect_b + '">channels.m3u</a> and <a href="/guide.xml?includeTeams=342,422' + content_protect_b + '">guide.xml</a></p>' + "\n"

    body += '<p><span class="tooltip">Include (or exclude) Multiview<span class="tooltiptext">Requires starting and stopping the multiview stream from the web interface.</span></span>: <a href="/channels.m3u?includeTeams=342,422,multiview' + content_protect_b + '">channels.m3u</a> and <a href="/guide.xml?includeTeams=342,422,multiview' + content_protect_b + '">guide.xml</a></p>' + "\n"

    body += '</td></tr></table><br/>' + "\n"

    body += '<table><tr><td>' + "\n"
    body += '<p>Example links:</p>' + "\n"
    body += '<p>' + "\n"
    let example_types = [ ['embed.html', 'Embed'], ['stream.m3u8', 'Stream'], ['chromecast.html', 'Chromecast'], ['kodi.strm', 'Kodi'] ]

    let examples = [
      ['Team live video', '?teamId=488&resolution=720p60'],
      ['Team yesterday video', '?teamId=488&resolution=720p60&date=yesterday'],
      ['Catch-up/condensed', '?teamId=488&resolution=720p60&skip=pitches&date=today'],
      ['Condensed yesterday', '?teamId=488&resolution=720p60&skip=pitches&date=yesterday'],
      ['Same but DH game 2', '?teamId=488&resolution=720p60&skip=pitches&date=yesterday&game=2']
    ]

    for (var i=0; i<examples.length; i++) {
      body += '&bull; <span class="tooltip">' + examples[i][0] + '<span class="tooltiptext">Click or tap on a team name in the schedule table above to see its id number.</span></span>: '
      for (var j=0; j<example_types.length; j++) {
        body += '<a href="/' + example_types[j][0] + examples[i][1]
        body += content_protect_b
        body += '">' + example_types[j][1] + '</a>'
        if ( j < (example_types.length-1) ) {
          body += ' | '
        } else {
          body += '<br/>' + "\n"
        }
      }
    }
    body += '</p></td></tr></table><br/>' + "\n"

    let local_url = '' // default to embedded player
    let urlArray = req.url.split('?')
    if ( (urlArray.length == 2) ) {
      local_url += '?' + urlArray[1]
    }
    let media_center_link = '/live-stream-games/' + gameDate.replace(/-/g,'/') + local_url
    body += '<p><span class="tooltip">Media Center View<span class="tooltiptext">Allows you to use the MiLB Media Center page format for nagivation.</span></span>: <a href="' + media_center_link + '" target="_blank">Link</a></p>' + "\n"

    body += '<p><span class="tooltip">Sample video<span class="tooltiptext">A sample stream. Useful for testing and troubleshooting.</span></span>: <a href="/embed.html' + content_protect_a + '">Embed</a> | <a href="/stream.m3u8' + content_protect_a + '">Stream</a> | <a href="/chromecast.html' + content_protect_a + '">Chromecast</a> | <a href="/advanced.html' + content_protect_a + '">Advanced</a></p>' + "\n"

    // Print version
    body += '<p class="tinytext">Version ' + version + '</p>' + "\n"

    // Datepicker functions
    body += '<script>var datePicker=document.getElementById("gameDate");function changeDate(e){date=datePicker.value;reload()}function removeDate(e){datePicker.removeEventListener("change",changeDate,false);datePicker.addEventListener("blur",changeDate,false);if(e.keyCode===13){date=datePicker.value;reload()}}datePicker.addEventListener("change",changeDate,false);datePicker.addEventListener("keypress",removeDate,false)</script>' + "\n"

    body += "</body></html>"

    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(body)
  } catch (e) {
    session.log('home request error : ' + e.message)
    res.end('')
  }
})

// Listen for OPTIONS requests and respond with CORS headers
app.options('*', function(req, res) {
  session.requestlog('options', req, true)
  var cors_headers = {
    'access-control-allow-headers': 'Origin, X-Requested-With, Content-Type, accessToken, Authorization, Accept, Range',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': 0
  }
  res.writeHead(204, cors_headers)
  res.end()
  return
})

// Listen for live-stream-games (schedule) page requests, return the page after local url substitution
app.get('/live-stream-games*', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('live-stream-games', req)

  // check for a linkType parameter in the url
  let linkType = VALID_LINK_TYPES[0]
  if ( req.query.linkType ) {
    linkType = req.query.linkType
    session.setLinkType(linkType)
  }

  // use the link type to determine the local url to use
  var local_url = '/embed.html' // default to embedded player
  if ( linkType == VALID_LINK_TYPES[1] ) { // direct stream
    local_url = '/stream.m3u8'
  } else { // other
    local_url = '/' + linkType + '.html'
  }
  let urlArray = req.url.split('?')
  if ( (urlArray.length == 2) ) {
    local_url += '?' + urlArray[1]
  }

  // remove our local parameters, if specified, from the url we will fetch remotely
  var remote_url = url.parse(req.url).pathname

  let reqObj = {
    url: 'https://www.milb.com' + remote_url,
    headers: {
      'User-Agent': session.getUserAgent(),
      'Origin': 'https://www.mlib.com',
      'Referer': 'https://www.mlib.com/',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    gzip: true
  }

  var body = await session.httpGet(reqObj)

  // a regex substitution to change existing links to local urls
  body = body.replace(/<button name="watch" class="milbtv__btn milbtv__btn--watch" data-gamepk="(\d+)/g,'<a href="'+local_url+'&gamePk=$1')

  // a regex substitution to remove unsupported filter menus
  if ( session.protection.content_protect ) {
    body = body.replace(/<div class="milbtv__filters">[\S\s]+Reset\n            <\/span>\n        <\/div>/g,'')
  }

  // hide popup to accept cookies
  body = body.replace(/www.googletagmanager.com/g,'0.0.0.0')

  res.end(body)
})

// Listen for embed request, respond with embedded hls.js player
app.get('/embed.html', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('embed.html', req)

  let video_url = '/stream.m3u8'
  if ( req.query.src ) {
    video_url = req.query.src
  } else {
    let urlArray = req.url.split('?')
    if ( (urlArray.length == 2) ) {
      video_url += '?' + urlArray[1]
    }
  }
  session.debuglog('embed src : ' + video_url)

  let startFrom = VALID_START_FROM[0]
  if ( req.query.startFrom ) {
    startFrom = req.query.startFrom
  }
  let controls = VALID_CONTROLS[0]
  if ( req.query.controls ) {
    controls = req.query.controls
  }

  let content_protect = ''
  if ( session.protection.content_protect ) {
    content_protect = '?content_protect=' + session.protection.content_protect
  }

  // Adapted from https://hls-js.netlify.app/demo/basic-usage.html
  var body = '<html><head><meta charset="UTF-8"><meta http-equiv="Content-type" content="text/html;charset=UTF-8"><title>' + appname + ' player</title><link rel="icon" href="favicon.svg"><style type="text/css">input[type=text],input[type=button]{-webkit-appearance:none;-webkit-border-radius:0}body{background-color:black;color:lightgrey;font-family:Arial,Helvetica,sans-serif}video{width:100% !important;height:auto !important;max-width:1280px}input[type=number]::-webkit-inner-spin-button{opacity:1}button{color:lightgray;background-color:black}button.default{color:black;background-color:lightgray}</style><script>function goBack(){var prevPage=window.location.href;window.history.go(-1);setTimeout(function(){if(window.location.href==prevPage){window.location.href="/' + content_protect + '"}}, 500)}function toggleAudio(x){var elements=document.getElementsByClassName("audioButton");for(var i=0;i<elements.length;i++){elements[i].className="audioButton"}document.getElementById("audioButton"+x).className+=" default";hls.audioTrack=x}function changeTime(x){video.currentTime+=x}function changeRate(x){let newRate=Math.round((Number(document.getElementById("playback_rate").value)+x)*10)/10;if((newRate<=document.getElementById("playback_rate").max) && (newRate>=document.getElementById("playback_rate").min)){document.getElementById("playback_rate").value=newRate.toFixed(1);video.defaultPlaybackRate=video.playbackRate=document.getElementById("playback_rate").value}}function myKeyPress(e){if(e.key=="ArrowRight"){changeTime(10)}else if(e.key=="ArrowLeft"){changeTime(-10)}else if(e.key=="ArrowUp"){changeRate(0.1)}else if(e.key=="ArrowDown"){changeRate(-0.1)}}</script></head><body onkeydown="myKeyPress(event)"><script src="https://hls-js.netlify.app/dist/hls.js"></script><video id="video"'
  if ( controls == VALID_CONTROLS[0] ) {
    body += ' controls'
  }
  body += '></video><script>var video=document.getElementById("video");var track;if(Hls.isSupported()){var hls=new Hls('

  if ( startFrom != VALID_START_FROM[1] ) {
    body += '{startPosition:0,liveSyncDuration:32400,liveMaxLatencyDuration:32410}'
  }

  body += ');hls.loadSource("' + video_url + '");hls.attachMedia(video);hls.on(Hls.Events.MEDIA_ATTACHED,function(){video.muted=true;video.play()});hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function(){var audioSpan=document.getElementById("audioSpan");var audioButtons="";for(var i=0;i<hls.audioTracks.length;i++){audioButtons+=\'<button id="audioButton\'+i+\'" class="audioButton\';if(i==0){audioButtons+=\' default\'}audioButtons+=\'" onclick="toggleAudio(\'+i+\')">\'+hls.audioTracks[i]["name"]+"</button> "}audioSpan.innerHTML=audioButtons});hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function(){track=video.textTracks && video.textTracks[0]})}else if(video.canPlayType("application/vnd.apple.mpegurl")){video.src="' + video_url + '";video.addEventListener("canplay",function(){video.play()})}</script><p>Skip: <button onclick="changeTime(-10)">- 10 s</button> <button onclick="changeTime(10)">+ 10 s</button> <button onclick="changeTime(30)">+ 30 s</button> <button onclick="changeTime(90)">+ 90 s</button> '

  body += '<button onclick="changeTime(video.duration-10)">Latest</button> '

  body += '<button id="airplay">AirPlay</button></p><p>Playback rate: <input type="number" value=1.0 min=0.1 max=16.0 step=0.1 id="playback_rate" size="8" style="width: 4em" onchange="video.defaultPlaybackRate=video.playbackRate=this.value"></p><p>Audio: <button onclick="video.muted=!video.muted">Toggle Mute</button> <span id="audioSpan"></span></p><p>Captions: <button onclick="if(track){if(track.mode.indexOf(\'showing\') >= 0){track.mode = \'hidden\'}else{track.mode=\'showing\'}}">Toggle Captions</button> <span id="audioSpan"></span></p><p>Controls: <button onclick="video.controls=!video.controls">Toggle Controls</button></p><p><button onclick="goBack()">Back</button></p><script>var airPlay=document.getElementById("airplay");if(window.WebKitPlaybackTargetAvailabilityEvent){video.addEventListener("webkitplaybacktargetavailabilitychanged",function(event){switch(event.availability){case "available":airPlay.style.display="inline";break;default:airPlay.style.display="none"}airPlay.addEventListener("click",function(){video.webkitShowPlaybackTargetPicker()})})}else{airPlay.style.display="none"}</script></body></html>'
  res.end(body)
})

// Listen for advanced embed request, redirect to online demo hls.js player
app.get('/advanced.html', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('advanced.html', req)

  let server = 'http://' + req.headers.host

  let video_url = '/stream.m3u8'
  if ( req.query.src ) {
    video_url = req.query.src
  } else {
    let urlArray = req.url.split('?')
    if ( (urlArray.length == 2) ) {
      video_url += '?' + urlArray[1]
    }
    video_url = server + video_url
  }
  session.debuglog('advanced embed src : ' + video_url)

  res.redirect('http://hls-js.netlify.app/demo/?src=' + encodeURIComponent(video_url))
})

// Listen for Chromecast request, redirect to chromecast.link player
app.get('/chromecast.html', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('chromecast.html', req)

  let server = 'http://' + req.headers.host

  let video_url = '/stream.m3u8'
  if ( req.query.src ) {
    video_url = req.query.src
  } else {
    let urlArray = req.url.split('?')
    if ( (urlArray.length == 2) ) {
      video_url += '?' + urlArray[1]
    }
    video_url = server + video_url
  }
  session.debuglog('chromecast src : ' + video_url)

  res.redirect('https://chromecast.link#title=' + appname + '&content=' + encodeURIComponent(video_url))
})

// Listen for channels.m3u playlist request
app.get('/channels.m3u', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('channels.m3u', req)

  let includeTeams = []
  if ( req.query.includeTeams ) {
    includeTeams = req.query.includeTeams.toUpperCase().split(',')
  }
  let excludeTeams = []
  if ( req.query.excludeTeams ) {
    excludeTeams = req.query.excludeTeams.toUpperCase().split(',')
  }

  let includeOrgs = []
  if ( req.query.includeOrgs ) {
    includeOrgs = req.query.includeOrgs.toUpperCase().split(',')
  }

  let server = 'http://' + req.headers.host

  let resolution = 'best'
  if ( req.query.resolution ) {
    resolution = req.query.resolution
  }

  let pipe = 'false'
  if ( req.query.pipe ) {
    pipe = req.query.pipe
  }

  let startingChannelNumber = 1
  if ( req.query.startingChannelNumber ) {
    startingChannelNumber = req.query.startingChannelNumber
  }

  var body = await session.getTVData('channels', includeTeams, excludeTeams, includeOrgs, server, resolution, pipe, startingChannelNumber)

  res.writeHead(200, {'Content-Type': 'audio/x-mpegurl'})
  res.end(body)
})

// Listen for guide.xml request
app.get('/guide.xml', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('guide.xml', req)

  let includeTeams = []
  if ( req.query.includeTeams ) {
    includeTeams = req.query.includeTeams.toUpperCase().split(',')
  }
  let excludeTeams = []
  if ( req.query.excludeTeams ) {
    excludeTeams = req.query.excludeTeams.toUpperCase().split(',')
  }

  let includeOrgs = []
  if ( req.query.includeOrgs ) {
    includeOrgs = req.query.includeOrgs.toUpperCase().split(',')
  }

  let server = 'http://' + req.headers.host

  var body = await session.getTVData('guide', includeTeams, excludeTeams, includeOrgs, server)

  res.end(body)
})

// Listen for image requests
app.get('/image.svg', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('image.svg', req, true)

  let teamId = 'MILB'
  if ( req.query.teamId ) {
    teamId = req.query.teamId
  }

  var body = await session.getImage(teamId)

  res.writeHead(200, {'Content-Type': 'image/svg+xml'})
  res.end(body)
})

// Listen for favicon requests
app.get('/favicon.svg', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  session.requestlog('favicon.svg', req, true)

  var body = await session.getImage('MILB')

  res.writeHead(200, {'Content-Type': 'image/svg+xml'})
  res.end(body)
})

// Listen for multiview requests
app.get('/multiview', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  try {
    session.requestlog('multiview', req)

    try {
      ffmpeg_command.kill()
      session.clear_multiview_files()
    } catch (e) {
      //session.debuglog('error killing multiview command:' + e.message)
    }

    if ( req.query.streams ) {
      let sync = []
      if ( req.query.sync ) {
        sync = req.query.sync
      }
      let dvr = false
      if ( req.query.dvr ) {
        dvr = req.query.dvr
      }
      let faster = false
      if ( req.query.faster ) {
        faster = req.query.faster
        dvr = true
      }
      let reencode = false
      if ( req.query.reencode ) {
        reencode = req.query.reencode
      }
      let audio_url = false
      if ( req.query.audio_url && (req.query.audio_url != '') ) {
        audio_url = req.query.audio_url
      }
      let audio_url_seek = false
      if ( req.query.audio_url_seek && (req.query.audio_url_seek != '0') ) {
        audio_url_seek = req.query.audio_url_seek
      }
      // Wait to restart it
      setTimeout(function() {
        res.end(start_multiview_stream(req.query.streams, sync, dvr, faster, reencode, audio_url, audio_url_seek))
      }, 5000)
    } else {
      res.end('stopped')
    }
  } catch (e) {
    session.log('multiview request error : ' + e.message)
    res.end('multiview request error, check log')
  }
})

function start_multiview_stream(streams, sync, dvr, faster, reencode, audio_url, audio_url_seek) {
  try {
    ffmpeg_command = ffmpeg({ timeout: 432000 })

    // If it's not already an array (only 1 parameter was passed in URL), convert it
    if ( !Array.isArray(streams) ) streams = [streams]
    if ( !Array.isArray(sync) ) sync = [sync]

    // Max 4 streams
    var stream_count = Math.min(streams.length, 4)

    var audio_present = []
    var complexFilter = []
    var xstack_inputs = []
    var xstack_layout = '0_0|w0_0'
    var map_audio = ''

    // Video
    let video_output = '0'
    for (var i=0; i<stream_count; i++) {
      let url = streams[i]

      // Stream URL for testing
      //url = SAMPLE_STREAM_URL

      // Set input stream and its thread queue size
      ffmpeg_command.input(url)
      .addInputOption('-thread_queue_size', '4096')

      // We'll limit our encoding to real-time as long as the "faster" box wasn't checked
      if ( !faster ) ffmpeg_command.native()

      // Only apply filters if more than 1 stream
      if ( stream_count > 1 ) {
        complexFilter.push({
          filter: 'setpts=PTS-STARTPTS',
          inputs: i+':v:0',
          outputs: 'v'+i
        })
        xstack_inputs.push('v'+i)
      }

      // Check if audio is present
      if ( url.indexOf('audio_track=none') === -1 ) {
        audio_present.push(i)
      }
    }

    // Alternate audio track, if provided
    if ( audio_url ) {
      ffmpeg_command.input(audio_url)
      .addInputOption('-thread_queue_size', '4096')

      if ( !faster ) ffmpeg_command.native()

      audio_present.push(stream_count)
      if ( audio_url_seek && (audio_url_seek != 0) ) {

        if ( audio_url_seek > 0 ) {
          sync.push(audio_url_seek)
        } else if ( audio_url_seek < 0 ) {
          session.log('trimming audio for stream ' + stream_count + ' by ' + audio_url_seek + ' seconds')
          ffmpeg_command.addInputOption('-ss', (audio_url_seek * -1))
        }
      }
    }

    // More video
    // Only apply filters if more than 1 stream
    if ( stream_count > 1 ) {
      video_output = 'out'
      if ( stream_count > 2 ) xstack_layout += '|0_h0'
      if ( stream_count > 3 ) xstack_layout += '|w0_h0'
      complexFilter.push({
        filter: 'xstack',
        options: { inputs:stream_count, layout: xstack_layout, fill:'black' },
        inputs: xstack_inputs,
        outputs: video_output
      })
      video_output = '[' + video_output + ']'
    }

    // Audio
    // Since audio filters require re-encoding, only apply them if sync value is specified or if "re-encode" box is checked
    // Filters: resampling preserve timestamps and padding allows the multiview stream to continue if one stream ends
    audio_reencoded = []
    for (var i=0; i<audio_present.length; i++) {
      let audio_input = audio_present[i] + ':m:language:en?'
      let filter = ''
      // Optionally apply sync adjustments
      if ( sync[audio_present[i]] ) {
        if ( sync[audio_present[i]] > 0 ) {
          session.log('delaying audio for stream ' + (audio_present[i]+1) + ' by ' + sync[audio_present[i]] + ' seconds')
          filter = 'adelay=' + (sync[i] * 1000) + ','
        } else if ( sync[audio_present[i]] < 0 ) {
          session.log('trimming audio for stream ' + (audio_present[i]+1) + ' by ' + sync[audio_present[i]] + ' seconds')
          filter = 'atrim=start=' + (sync[audio_present[i]] * -1) + 's,'
        }
      }
      if ( reencode || (filter != '') ) {
        audio_reencoded.push(audio_present[i])
        complexFilter.push({
          filter: 'aresample=async=1:first_pts=0,' + filter + 'asetpts=PTS-STARTPTS,apad',
          inputs: audio_input,
          outputs: 'out' + i
        })
      }
    }

    if ( complexFilter.length > 0 ) {
      ffmpeg_command.complexFilter(complexFilter)
    }
    ffmpeg_command.addOutputOption('-map', video_output + ':v')

    // Stream map will handle the audio track default/grouping
    var var_stream_map = 'v:0,agroup:aac'
    for (var i=0; i<audio_present.length; i++) {
      if ( audio_reencoded.indexOf(audio_present[i]) > -1 ) {
        audio_output = '[out' + i + ']'
      } else {
        audio_output = audio_present[i] + ':a:0'
      }
      ffmpeg_command.addOutputOption('-map', audio_output)
      var_stream_map += ' a:' + i + ',agroup:aac,language:ENG'
      if ( i == 0 ) {
        var_stream_map += ',default:yes'
      }
    }

    // Default to keep only 1 minute of segments on disk, unless dvr is specified
    var hls_list_size = 60 / SECONDS_PER_SEGMENT
    var delete_segments = 'delete_segments+'
    if ( dvr ) {
      hls_list_size = 0
      delete_segments = ''
    }

    if ( stream_count > 1 ) {
      // Only re-encode video if there is more than 1 video stream
      let bandwidth = 1040 * stream_count
      ffmpeg_command.addOutputOption('-c:v', ffmpegEncoder)
      .addOutputOption('-pix_fmt:v', 'yuv420p')
      .addOutputOption('-r:v', '30')
      .addOutputOption('-b:v', bandwidth.toString() + 'k')
    } else {
      // If only 1 video stream, just copy the video without re-encoding
      ffmpeg_command.addOutputOption('-c:v', 'copy')
    }
    if ( ffmpegEncoder == defaultEncoder ) {
      // If using software encoder, add preset to reduce CPU usage
      ffmpeg_command.addOutputOption('-preset:v', 'superfast')
    } else if ( ffmpegEncoder == 'h264_v4l2m2m' ) {
      // Otherwise if using this Linux hardware encoder, set some additional variables
      // per https://www.willusher.io/general/2020/11/15/hw-accel-encoding-rpi4
      ffmpeg_command.addOutputOption('-num_output_buffers', '32')
      .addOutputOption('-num_capture_buffers', '16')
    }

    // Audio again: check which audio tracks need re-encoding, and which can simply be copied
    for (var i=0; i<audio_present.length; i++) {
      if ( audio_reencoded.indexOf(audio_present[i]) > -1 ) {
        audio_encoder = 'aac'
      } else {
        audio_encoder = 'copy'
      }
      ffmpeg_command.addOutputOption('-c:a:' + i, audio_encoder)
    }
    // Drop subtitles/captions
    // End after 6 hours in case we forget to stop it manually
    // Set HLS parameters
    ffmpeg_command.addOutputOption('-sn')
    .addOutputOption('-t', '6:00:00')
    .addOutputOption('-f', 'hls')
    .addOutputOption('-hls_time', SECONDS_PER_SEGMENT)
    .addOutputOption('-hls_list_size', hls_list_size)
    .addOutputOption('-hls_allow_cache', '0')
    .addOutputOption('-hls_flags', delete_segments + 'independent_segments+discont_start+program_date_time')

    if ( dvr ) {
      ffmpeg_command.addOutputOption('-hls_playlist_type', 'event')
    }

    ffmpeg_command.addOutputOption('-start_number', '1')
    .addOutputOption('-hls_segment_filename', session.get_multiview_directory() + '/stream_%v_%d.ts')
    .addOutputOption('-var_stream_map', var_stream_map)
    .addOutputOption('-master_pl_name', multiview_stream_name)
    .addOutputOption('-y')
    .output(session.get_multiview_directory() + '/stream-%v.m3u8')
    .on('start', function(commandLine) {
      session.log('multiview stream started')
      ffmpeg_status = true
      if ( argv.debug || argv.ffmpeg_logging ) {
        session.log('multiview stream command: ' + commandLine)
      }
    })
    .on('error', function(err, stdout, stderr) {
      session.log('multiview stream stopped: ' + err.message)
      ffmpeg_status = false
      if ( stdout ) session.log(stdout)
      if ( stderr ) session.log(stderr)
    })
    .on('end', function() {
      session.log('multiview stream ended')
      ffmpeg_status = false
    })

    if ( argv.ffmpeg_logging ) {
      session.log('ffmpeg output logging enabled')
      ffmpeg_command.on('stderr', function(stderrLine) {
        session.log(stderrLine);
      })
    }

    ffmpeg_command.run()

    session.log('multiview stream command started')

    return 'started'
  } catch (e) {
    session.log('multiview start error : ' + e.message)
    return 'multiview start error, check log'
  }
}

// Listen for Kodi STRM file requests
app.get('/kodi.strm', async function(req, res) {
  if ( ! (await protect(req, res)) ) return

  try {
    session.requestlog('kodi.strm', req)

    let server = 'http://' + req.headers.host

    let video_url = '/stream.m3u8'
    let file_name = 'kodi'
    if ( req.query.src ) {
      video_url = req.query.src
    } else {
      let urlArray = req.url.split('?')
      if ( (urlArray.length == 2) ) {
        video_url += '?' + urlArray[1]
        let paramArray = urlArray[1].split('=')
        for (var i=1; i<paramArray.length; i++) {
          let param = paramArray[i].split('&')
          file_name += '.' + param[0]
        }
      }
      video_url = server + video_url
    }

    var inputstream_property_name = 'inputstreamaddon'
    if ( req.query.version && (req.query.version == '18') ) {
      inputstream_property_name = 'inputstream.adaptive'
    }

    var body = '#KODIPROP:mimetype=application/vnd.apple.mpegurl' + "\n" + '#KODIPROP:' + inputstream_property_name + '=inputstream.adaptive' + "\n" + '#KODIPROP:inputstream.adaptive.manifest_type=hls' + "\n" + video_url

    var download_headers = {
      'Content-Disposition': 'attachment; filename="' + file_name + '.strm"'
    }
    res.writeHead(200, download_headers)

    res.end(body)
  } catch (e) {
    session.log('kodi.strm request error : ' + e.message)
    res.end('kodi.strm request error, check log')
  }
})