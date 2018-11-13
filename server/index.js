require('dotenv').config()
const opmlToJSON = require('opml-to-json')
const request = require('request')
const requestPromise = require('request-promise-native')
const express = require('express')
const {promisify} = require('util')
const url = require('url')
const FeedParser = require('feedparser')
const puppeteer = require('puppeteer')

const fetchOPML = () => {
  return requestPromise(process.env.OPML_URL)
    .then(opml => promisify(opmlToJSON)(opml))
}

const fetchFeed = (feed) => {
  return new Promise((resolve, reject) => {
    console.log(feed)
    const items = []
    const req = request({
      'uri': feed,
      'agent': false,
      'pool': {
        'maxSockets': 1000
      }
    })
    const feedparser = new FeedParser()
    feedparser.on('error', (err) => {
      reject(err)
    })
    req.on('error', (err) => {
      reject(err)
    })
    req.on('response', function (res) {
      console.log('Parsing ' + feed)
      var stream = this
      if (res.statusCode === 200) {
        stream.pipe(feedparser)
      } else {
        resolve([])
      }
    })
    feedparser.on('readable', function () {
      var stream = this
      var item
      while ((item = stream.read()) !== null) {
        items.push(item)
      }
    })
    feedparser.on('end', function () {
      console.log('Done parsing ' + feed)
      resolve(items)
    })
  })
    .catch((err) => {
      console.error(feed, err)
      return Promise.resolve([])
    })
}

const _getItemSummary = (summaries, item) => {
  if (summaries[item.link]) {
    return summaries[item.link]
  } else if (item['content:encoded'] && item['content:encoded']['#']) {
    return item['content:encoded']['#']
  } else if (item['atom:content'] && item['atom:content']['#']) {
    return item['atom:content']['#']
  } else if (item['atom:summary'] && item['atom:summary']['#']) {
    return item['atom:summary']['#']
  } else if (item.description) {
    return item.description
  }
  return ''
}

const _fetchTreeFeeds = (summaries, tree, collector = []) => {
  if (tree.children) {
    const _collector = []
    console.log('Loading ' + tree.title)
    return Promise.all(tree.children.map(child => _fetchTreeFeeds(summaries, child, _collector)))
      .then(children => {
        console.log('Done loading ' + tree.title)
        const datedUniqueItems = _collector.filter((item, i) => {
          if (item.pubdate === null) {
            return false
          }
          const similar = _collector.slice(0, i).find(_item => _item.link === item.link || _item.guid === item.guid)
          if (similar) {
            return false
          }
          return true
        })
        datedUniqueItems.sort((a, b) => {
          return b.pubdate.getTime() - a.pubdate.getTime()
        })
        return {
          'title': tree.title,
          'items': datedUniqueItems.slice(0, parseInt(process.env.N_ITEMS || 10)).map(item => {
            return {
              title: item.title,
              link: item.link,
              summary: _getItemSummary(summaries, item),
              image: item.image && item.image.url ? item.image.url : null,
              subheads: [
                item.author,
                url.parse(item.link).hostname,
                new Date().toDateString() === item.pubdate.toDateString() ? item.pubdate.toLocaleTimeString('en-US') : item.pubdate.toLocaleDateString('en-US')
              ].filter(s => s && s.length > 0)
            }
          })
        }
      })
  } else if (tree.type && tree.type === 'rss' && tree.xmlurl) {
    return fetchFeed(tree.xmlurl)
      .then(items => {
        items.forEach(item => collector.push(item))
      })
  }
}

const fetchTreeFeeds = (summaries, tree) => {
  return Promise.all(tree.children.map(child => _fetchTreeFeeds(summaries, child)))
}

const _fetchItemSummary = (browser, item) => {
  return browser.newPage()
    .then(page => {
      return page.goto(item.link)
        .then(() => {
          return page.evaluate(() => {
            const element = document.querySelector('[itemprop="articleBody"]')
            return element ? element.innerHTML : null
          })
        })
        .then(summary => {
          return page.close()
            .then(() => {
              return (summary && summary.trim().length > 0) ? summary : item.summary
            })
        })
    })
    .catch(err => {
      console.error(err)
      return item.summary
    })
}

const _findBestSummaries = (browser, items, newItems = [], i = 0) => {
  if (i < items.length) {
    const item = items[i]
    if (!item.summary || item.summary.length < 1000) {
      return _fetchItemSummary(browser, item)
        .then(summary => {
          newItems.push(Object.assign({}, item, {summary}))
          return _findBestSummaries(browser, items, newItems, i + 1)
        })
    } else {
      newItems.push(item)
      return _findBestSummaries(browser, items, newItems, i + 1)
    }
  }
  return Promise.resolve(newItems)
}

const findBestSummaries = (browser, feeds) => {
  const summaries = {}
  return Promise.all(feeds.map(feed => {
    return _findBestSummaries(browser, feed.items)
      .then(items => {
        items.forEach(item => {
          summaries[item.link] = item.summary
        })
        return Object.assign({}, feed, {items})
      })
  }))
    .then(feeds => {
      return {feeds, summaries}
    })
}

const main = () => {
  let feedCache = null
  let lastUpdated = null
  let lastError = null
  let summariesCache = {}

  puppeteer.launch({args: ['--no-sandbox']})
    .then((browser) => {
      const runFetch = () => {
        fetchOPML()
          .then(data => fetchTreeFeeds(summariesCache, data))
          .then(data => {
            console.log('Feed updated')
            feedCache = data
            return findBestSummaries(browser, data)
          })
          .then(({summaries, feeds}) => {
            console.log('Feed summaries updated')
            summariesCache = summaries
            feedCache = feeds
            lastUpdated = new Date()
            lastError = null
          })
          .catch(e => {
            console.error(e)
            lastError = e
          })
      }
      setInterval(() => runFetch(), 1000 * 60 * parseInt(process.env.REFRESH_MINUTES || 5))
      runFetch()
    
      const app = express()
      app.use(express.static('build'))
      app.get('/data', (req, res) => {
        res.send({
          feeds: feedCache || [],
          lastUpdated,
          lastError,
          name: process.env.NAME || 'FeedPage'
        })
      })
      app.listen(process.env.PORT || 8000)
    })
    .catch(e => {
      console.error(e)
    })
}

main()
