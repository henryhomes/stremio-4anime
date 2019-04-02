const needle = require('needle')
const async = require('async')
const pUrl = require('url').parse
const cheerio = require('cheerio')
const db = require('./lib/cache')

const package = require('./package')


// genres: ["Action","Adventure","Cartoon","Comedy","Dementia","Demons","Drama","Ecchi","Fantasy","Game","Harem","Historical","Horror","Josei","Magic","Martial Arts","Mecha","Military","Music","Mystery","Parody","Police","Psychological","Romance","Samurai","School","Sci-Fi","Seinen","Shoujo","Shoujo Ai","Shounen","Shounen Ai","Slice of Life","Space","Sports","Super Power","Supernatural","Thriller","Vampire"],
// ^ complete genre list, drastically reduced as some genres are empty

const movieGenres = ["Action","Adventure","Comedy","Drama","Fantasy","Magic","Martial Arts","Mystery","Police","Romance","School","Shounen","Slice of Life","Super Power","Supernatural"]
const seriesGenres = ["Action","Adventure","Comedy","Demons","Drama","Ecchi","Fantasy","Game","Harem","Historical","Horror","Josei","Magic","Martial Arts","Mecha","Military","Music","Mystery","Parody","Police","Psychological","Romance","Samurai","School","Sci-Fi","Seinen","Shoujo","Shoujo Ai","Shounen","Shounen Ai","Slice of Life","Space","Sports","Super Power","Supernatural","Thriller","Vampire"]

const manifest = {
    id: 'org.4anime.anime',
    version: package.version,
    logo: 'https://steamuserimages-a.akamaihd.net/ugc/83716007333628022/9EC4663B39FD4A62BDBA091C31F1C5C3B2969873/?imw=150&imh=150&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=true',
    name: 'Anime from 4anime',
    description: 'Anime from 4anime',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    idPrefixes: ['kitsu:'],
    catalogs: [
      {
        type: 'series',
        id: '4anime-search',
        name: '4anime',
        extra: [
          {
            name: 'search',
            isRequired: true
          }
        ]
      },
      {
        type: 'movie',
        id: '4anime-movie-list',
        name: '4anime',
        genres: movieGenres,
        extra: [
          {
            name: 'genre'
          }
        ]
      },
      {
        type: 'series',
        id: '4anime-series-list',
        name: '4anime',
        genres: seriesGenres,
        extra: [
          {
            name: 'genre'
          }
        ]
      }
    ]
}

const { addonBuilder, serveHTTP, publishToCentral }  = require('stremio-addon-sdk')

const addon = new addonBuilder(manifest)

const endpoint = 'https://4anime.to/wp-admin/admin-ajax.php'

const headers = {
  'Accept': 'text/plain, */*; q=0.01',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Origin': 'https://4anime.to',
  'Referer': 'https://4anime.to/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.121 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
}

const mapToKitsu = {}
const mapToPoster = {}

const cache = {
  catalog: {}
}

function toMeta(kitsuId, obj) {
  const newObj = JSON.parse(JSON.stringify(obj))
  newObj.id = mapToKitsu[kitsuId]
  newObj.poster = mapToPoster[kitsuId]
  newObj.type = 'series'
  return newObj
}

function toGenreTag(genre) {
  return genre.toLowerCase().replace(/[^a-z0-9\s\-+]+/gi, '').split(' ').join('-')
}

function toSlug(title, type) {
  let slug = title.replace(/[^a-z0-9\s\-!+]+/gi, '').split(' ').join('-')
//  slug += '-Episode-'
  slug += (type == 'series' ? '-Episode-' : '')
  return slug
}

function getSlugs(title, type) {
  const slugs = []
  slugs.push(toSlug(title, type))
  if (title.includes(':'))
    slugs.push(toSlug(title.substr(0, title.indexOf(':')), type))
  return slugs
}

function serialize( obj ) {
  return '?'+Object.keys(obj).reduce(function(a,k){a.push(k+'='+encodeURIComponent(obj[k]));return a},[]).join('&')
}

addon.defineCatalogHandler(args => {
  return new Promise((resolve, reject) => {

    let query
    let method
    let reqUrl
    const page = 1

    if (args.extra.search) {
      method = 'post'
      query = {
        action: 'ajaxsearchlite_search',
        aslp: args.extra.search,
        asid: 1,
        options: 'qtranslate_lang=0&set_intitle=None&customset%5B%5D=anime'
      }
      reqUrl = endpoint
    } else {
      method = 'get'
      reqUrl = 'https://4anime.to/'
      query = {
        sfid: args.type == 'series' ? 924 : 926,
        sf_action: 'get_data',
        sf_data: 'results',
        sf_paged: page
      }
      if (args.extra.genre)
        query._sft_genre = toGenreTag(args.extra.genre)
      query._sft_type = args.type == 'series' ? 'tv-series' : 'movie'
    }

    const queryTag = JSON.stringify(query)

    if (cache.catalog[queryTag]) {
      resolve({ metas: cache.catalog[queryTag], cacheMaxAge: 1209600 }) // cache 14 days
      return
    }

    const redisKey = args.extra.search ? null : (args.type + '-' + (args.extra.genre || 'default'))

    function getKitsu(suggestMetas, responded) {
        if (suggestMetas.length) {
          const metas = []
          const queue = async.queue((task, cb) => {
            if (mapToKitsu[task.name]) {
              metas.push(toMeta(task.name, task))
              cb()
              return
            }
            const type = task.type
            function searchKitsu(query, callback) {
              needle.get(kitsuEndpoint + '/catalog/' + type + '/kitsu-search-' + type + '/search=' + encodeURIComponent(query) + '.json', (err, resp, body) => {
                const kitsuMetas = (body || {}).metas || []
                let meta
                if (kitsuMetas.length) {
                  if (task.releaseInfo) {
                    const found = kitsuMetas.some(el => {
                      if (el.releaseInfo && el.releaseInfo.startsWith(task.releaseInfo)) {
                        meta = el
                        return true
                      }
                    })
                  }
                  if (!meta)
                    meta = kitsuMetas[0]
                  db.map.set(meta.id, getSlugs(task.name, task.type))
                  mapToKitsu[task.name] = meta.id
                  mapToPoster[task.name] = meta.poster
                  meta.type = 'series'
                  metas.push(meta)
                }
                callback(!!meta)
              })
            }
            searchKitsu(task.name, success => {
              if (!success && task.name.toLowerCase().endsWith('season')) {
                let altQuery = task.name.split(' ')
                altQuery.splice(-1,1)
                altQuery[altQuery.length -1] = parseInt(altQuery[altQuery.length -1])
                searchKitsu(altQuery.join(' '), () => {
                  cb()
                })
              } else
                cb()
            })
          }, 1)
          queue.drain = () => {
            cache.catalog[queryTag] = metas
            // cache for 14 days (feed) / 1 day (search)
            setTimeout(() => {
              delete cache.catalog[queryTag]
            }, args.id == '4anime-search' ? 86400000 : 1209600000)
            if (redisKey)
              db.catalog.set(redisKey, page, metas)
            if (!responded) {
              if (metas.length)
                resolve({ metas, cacheMaxAge: 1209600 })
              else
                reject(new Error('No results for: ' + args.extra.search))
            }
          }
          suggestMetas.forEach(el => { queue.push(el) })
        } else if (!responded)
          reject('Meta error 3: ' + args.id)
    }

    function reqCb(err, resp, body, cb) {
      if (method == 'get' && (body || '').startsWith('{"results":"'))
        body = body.replace('{"results":"', '').slice(0, -2).replace(/[\\]+/g, "")
      const list = body || []
      if (list && list.length) {
        const $ = cheerio.load(list)
        let suggestMetas = []
        if (method == 'post') {
          suggestMetas = $('.item').map((ij, el) => {
            const elem = $(el)
            const obj = {
                name: elem.find('a.name').text(),
                poster: elem.find('img.thumb').attr('src'), // image has cors, we'll use the kitsu poster
            }
            let year
            elem.find('.meta').find('.yearzi').each((ij, meta) => {
              const content = $(meta).text()
              if (content == parseInt(content))
                year = content
              else
                type = content
            })
            obj.releaseInfo = year
            obj.genres = elem.find('.genre a').map((ij, genre) => { return $(genre).text() }).toArray()
            obj.type = type == 'TV Series' ? 'series' : type == 'Movie' ? 'movie' : false
            return obj
          }).toArray().filter(obj => { return !!obj.type })
        } else {
          suggestMetas = $('#headerDIV_2').children().map((ij, el) => {
            return {
              name: $(el).find('img').attr('alt'),
              poster: $(el).find('img').attr('src'),
              releaseInfo: $(el).find('center').text(),
              type: args.type
            }
          }).toArray().filter(obj => { return !!obj.name })
        }
        cb(suggestMetas)
      } else {
        console.error(new Error('Meta error 2: ' + args.id))
        cb([])
      }
    }

    if (method == 'get') {
      db.catalog.get(redisKey, page, redisMetas => {

        if (redisMetas)
          resolve({ metas: redisMetas, cacheMaxAge: 86400 })

        let allResults = []

        // IMPORTANT: when skipping take into account that we're getting 3 pages for the first request
        function getPage(callback) {
          needle.get(reqUrl + serialize(query), { headers }, (err, resp, body) => {
            reqCb(err, resp, body, suggestMetas => {
              if (suggestMetas.length == 14 && query.sf_paged < page + 2) {
                query.sf_paged++
                allResults = allResults.concat(suggestMetas)
                getPage(callback)
              } else if (suggestMetas.length) {
                allResults = allResults.concat(suggestMetas)
                callback(allResults, !!redisMetas)
              } else {
                callback(allResults, !!redisMetas)
              }
            })
          })
        }
        getPage(getKitsu)

      })
    } else
      needle.post(reqUrl, query, { headers }, (err, resp, body) => {
        reqCb(err, resp, body, getKitsu)
      })
  })
})

const kitsuEndpoint = 'https://addon.stremio-kitsu.cf'

addon.defineMetaHandler(args => {
  return new Promise((resolve, reject) => {
    needle.get(kitsuEndpoint + '/meta/' + args.type + '/' + args.id + '.json', (err, resp, body) => {
      if (body && body.meta)
        resolve(body)
      else
        reject(new Error('Could not get meta from kitsu api for: '+args.id))
    })
  })
})

const https = require('https')

function checkStream(url, cb) {
  const uri = pUrl(url)
  const options = {
      method: 'HEAD',
      host: uri.host,
      port: uri.port,
      path: uri.pathname
  }
  const req = https.request(options, r => {
      cb(r.statusCode == 200)
  })
  req.end()
}

function validatePatterns(patterns, cb) {
  const pattern = patterns[0]
  if (!pattern)
    cb(false)
  else {
    patterns.shift()
    checkStream(pattern, (exists) => {
      if (exists)
        cb(pattern)
      else
        validatePatterns(patterns, cb)
    })
  }
}

function checkTag(url, cb) {
  const uri = pUrl(url)
  const options = {
      method: 'HEAD',
      host: uri.host,
      port: uri.port,
      path: uri.pathname
  }
  const req = https.request(options, r => {
      cb(r.statusCode == 403)
  })
  req.end()
}

function isTagCorrect(slugs, cb, version) {
  const titleTag = slugs[0].endsWith('-Episode-') ? slugs[0].replace('-Episode-', '') :  slugs[0]
  version = version || 1
  checkTag('https://v' + version + '.4animu.me/' + titleTag + '/', r => {
    if (r)
      cb(slugs[0], titleTag, version)
    else if (version < 2) {
      version++
      isTagCorrect(slugs, cb, version)
    } else if (slugs.length > 1) {
      slugs.shift()
      isTagCorrect(slugs, cb)
    } else
      cb(false)
  })
}

function nth(n) {return["st","nd","rd"][((n+90)%100-10)%10-1]||"th"}

addon.defineStreamHandler(args => {
  return new Promise((resolve, reject) => {
    const id = args.id
    const cacheMaxAge = 1209600
    db.get(id, cacheMaxAge, cached => {
      if (cached) {
        resolve(cached)
        return
      }
      const idParts = id.split(':')
      const kitsuId = 'kitsu:' + idParts[1]
      const episode = idParts.length > 2 ? idParts[idParts.length -1] : 1
      db.map.get(kitsuId, id4 => {
        if (id4) {
          const cloneSlugs = JSON.parse(JSON.stringify(id4))
          isTagCorrect(cloneSlugs, (slug, titleTag, version) => {
            if (version) {
              db.map.set(kitsuId, [slug])
              let epSlugs = [slug]
              if (slug.endsWith('-Episode-')) {
                const epNum = episode < 100 ? ('0' + episode).slice(-2) : episode
                if (epNum != episode) {
                  epSlugs.push(slug)
                  epSlugs[1] += episode
                }
                epSlugs[0] += epNum
                if (slug.toLowerCase().includes('-season-'))
                  for (let i = 1; i <= 10; i++) {
                    if (slug.toLowerCase().includes('-'+i+nth(i)+'-season-')) {
                      epSlugs.push(slug.replace('-'+i+nth(i)+'-Season-', '-S' + i + '-') + epNum)
                      if (epNum != episode)
                        epSlugs.push(slug.replace('-'+i+nth(i)+'-Season-', '-S' + i + '-') + episode)
                      break
                    }
                  }
              }
              const patterns = [
                'https://v' + version + '.4animu.me/' + titleTag + '/{slug}-1080p.mp4',
                'https://v' + version + '.4animu.me/' + titleTag + '/{slug}.mp4',
              ]
              const builtPatterns = []
              patterns.forEach(pattern => {
                epSlugs.forEach(slug => {
                  builtPatterns.push(pattern.replace('{slug}', slug))
                })
              })
              validatePatterns(builtPatterns, pattern => {
                if (pattern) {
                  const streams = [{ title: 'Stream', url: pattern }]
                  db.set(args.id, streams)
                  resolve({ streams, cacheMaxAge })
                } else
                  reject('Could not find stream pattern for: ' + id)
              })
            } else
              reject('Slugs ' + JSON.stringify(id4) + ' are not correct for id: '+id)
          })
        } else 
          reject('Could not get streams for: ' + id)
      })
    })
  })
})

module.exports = addon.getInterface()
