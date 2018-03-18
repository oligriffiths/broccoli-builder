var broccoli = require('..')
var Builder = broccoli.Builder
var chai = require('chai'), expect = chai.expect
var chaiAsPromised = require('chai-as-promised'); chai.use(chaiAsPromised)
var RSVP = require('rsvp')
var heimdall = require('heimdalljs')

RSVP.on('error', function(error) {
  throw error
})

function countingTree (readFn, description) {
  return {
    read: function (readTree) {
      this.readCount++
      return readFn.call(this, readTree)
    },
    readCount: 0,
    description: description,
    cleanup: function () {
      var self = this

      return RSVP.resolve()
        .then(function() {
          self.cleanupCount++
        })
    },
    cleanupCount: 0
  }
}

describe('Builder', function() {
  describe('core functionality', function() {
    describe('build', function() {
      it('passes through string tree', function() {
        var builder = new Builder('someDir')
        return expect(builder.build()).to.eventually.have.property('directory', 'someDir')
      })

      it('calls read on the given tree object', function() {
        var builder = new Builder({
          read: function(readTree) { return 'someDir' }
        })
        return expect(builder.build()).to.eventually.have.property('directory', 'someDir')
      })
    })

    it('readTree deduplicates', function() {
      var subtree = new countingTree(function(readTree) { return 'foo' })
      var builder = new Builder({
        read: function(readTree) {
          return readTree(subtree).then(function(hash) {
            var dirPromise = readTree(subtree) // read subtree again
            expect(dirPromise.then).to.be.a('function')
            return dirPromise
          })
        }
      })
      return builder.build().then(function(hash) {
        expect(hash.directory).to.equal('foo')
        expect(subtree.readCount).to.equal(1)
      })
    })

    describe('cleanup', function() {
      it('is called on all trees called ever', function() {
        var tree = countingTree(function(readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          return readTree(this.readCount === 1 ? subtree1 : subtree2)
        })
        var subtree1 = countingTree(function(readTree) { return 'foo' })
        var subtree2 = countingTree(function(readTree) { throw new Error('bar') })
        var builder = new Builder(tree)
        return builder.build().then(function(hash) {
          expect(hash.directory).to.equal('foo')
          builder.build().catch(function(err) {
            expect(err.message).to.equal('The Broccoli Plugin: [object Object] failed with:')
            return builder.cleanup()
          })
          .finally(function() {
            expect(tree.cleanupCount).to.equal(1)
            expect(subtree1.cleanupCount).to.equal(1)
            expect(subtree2.cleanupCount).to.equal(1)
          });
        })
      })

      it('cannot build already cleanedup build', function (done) {
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          return readTree(this.readCount === 1 ? subtree1 : subtree2)
        })
        var subtree1 = countingTree(function (readTree) { return 'foo' })
        var subtree2 = countingTree(function (readTree) { throw new Error('bar') })
        var builder = new Builder(tree)
        builder.cleanup();
        builder.build().then(function (hash) {
          expect(false).to.equal(true, 'should not succeed');
          done();
        }).catch(function(e) {
          expect(tree.cleanupCount).to.equal(0)
          expect(subtree1.cleanupCount).to.equal(0)
          expect(subtree2.cleanupCount).to.equal(0)
          expect(e.message).to.equal('cannot build this builder, as it has been previously canceled');;
          done();
        });
      })

      it('a build step run once the build is cancelled will not wrong, and the build will fail', function (done) {
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          return readTree(this.readCount === 1 ? subtree1 : subtree2)
        })
        var subtree1 = countingTree(function (readTree) { return 'foo' })
        var subtree2 = countingTree(function (readTree) { throw new Error('bar') })
        var builder = new Builder(tree)
        var build = builder.build()
        builder.cleanup();
        build.then(function (hash) {
          expect(false).to.equal(true, 'should not succeed');
          done();
        }).catch(function(reason) {
          expect(tree.cleanupCount).to.equal(0)
          expect(subtree1.cleanupCount).to.equal(0)
          expect(subtree2.cleanupCount).to.equal(0)
          expect(reason.message).to.equal('Build Canceled');
          expect(reason.isSilentError).to.equal(true);;
          done();
        });
      })

      it('is calls trees so far read (after one step)', function (done) {
        var cleaner;
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          cleaner = builder.cleanup();
          return readTree(subtree1);
        })
        var subtree1 = countingTree(function (readTree) {
          return 'foo'
        })
        var builder = new Builder(tree)

        builder.build().then(function () {
          expect(true).to.equal(false, 'should not succeed')
          done();
        }).catch(function(reason) {
          expect(reason.message).to.equal('Build Canceled')
          return cleaner.then(function() {
            expect(tree.cleanupCount).to.equal(1)
            expect(subtree1.cleanupCount).to.equal(0) // never read the second, so we wont clean it up
            done();
          })
        })
      })
    })
  })

  it('tree graph', function() {
    var parent = countingTree(function(readTree) {
      return readTree(child).then(function(dir) {
        return new RSVP.Promise(function(resolve, reject) {
          setTimeout(function() { resolve('parentTreeDir') }, 30)
        })
      })
    }, 'parent')

    var child = countingTree(function(readTree) {
      return readTree('srcDir').then(function(dir) {
        return new RSVP.Promise(function(resolve, reject) {
          setTimeout(function() { resolve('childTreeDir') }, 20)
        })
      })
    }, 'child')

    var timeEqual = function(a, b) {
      expect(a).to.be.a('number')

      // do not run timing assertions in Travis builds
      // the actual results of process.hrtime() are not
      // reliable
      if (process.env.CI !== 'true') {
        expect(a).to.be.within(b - 5e7, b + 5e7)
      }
    }

    var builder = new Builder(parent)
    return builder.build().then(function(hash) {
      expect(hash.directory).to.equal('parentTreeDir')
      var parentNode = hash.graph
      expect(parentNode.directory).to.equal('parentTreeDir')
      expect(parentNode.tree).to.equal(parent)
      expect(parentNode.subtrees.length).to.equal(1)
      var childNode = parentNode.subtrees[0]
      expect(childNode.directory).to.equal('childTreeDir')
      expect(childNode.tree).to.equal(child)
      expect(childNode.subtrees.length).to.equal(1)
      var leafNode = childNode.subtrees[0]
      expect(leafNode.directory).to.equal('srcDir')
      expect(leafNode.tree).to.equal('srcDir')
      expect(leafNode.subtrees.length).to.equal(0)
    })

    var json = heimdall.toJSON()

    expect(json.nodes.length).to.equal(4)

    var parentNode = json.nodes[1]
    timeEqual(parentNode.stats.time.self, 30e6)

    var childNode = json.nodes[2]
    timeEqual(childNode.stats.time.self, 20e6)

    var leafNode = json.nodes[3]
    timeEqual(leafNode.stats.time.self, 0)

    for (var i=0; i<json.nodes.length; ++i) {
      delete json.nodes[i].stats.time.self
    }
    
    expect(json).to.deep.equal(json, {
      nodes: [{
        _id: 0,
        id: {
          name: 'heimdall',
        },
        stats: {
          own: {},
          time: {},
        },
        children: [1],
      }, {
        _id: 1,
        id: {
          name: 'parent',
          broccoliNode: true,
        },
        stats: {
          own: {},
          time: {},
        },
        children: [2],
      }, {
        _id: 2,
        id: {
          name: 'child',
          broccoliNode: true,
        },
        stats: {
          own: {},
          time: {},
        },
        children: [3],
      }, {
        _id: 3,
        id: {
          name: 'srcDir',
          broccoliNode: true,
        },
        stats: {
          own: {},
          time: {},
        },
        children: [],
      }],
    })
  })

  it('string tree callback', function() {
    var builder = new Builder('fooDir')
    var callbackCalled = false
    return builder.build(function willReadStringTree(dir) {
      expect(dir).to.equal('fooDir')
      callbackCalled = true
    }).then(function() {
      expect(callbackCalled).to.be.ok
    })
  })

  it('start/stop events', function (done) {
    // Can be removed in 1.0.0
    var builder = new Builder('fooDir')
    var startWasCalled = 0;
    var stopWasCalled = 0;
    builder.on('start', function() {
      startWasCalled++;
    });

    builder.on('end', function() {
      stopWasCalled++;
    });

    expect(startWasCalled).to.equal(0);
    expect(stopWasCalled).to.equal(0);

    builder.build(function willReadStringTree (dir) {
      expect(startWasCalled).to.equal(1);
      expect(stopWasCalled).to.equal(0);
      expect(dir).to.equal('fooDir')
    }).finally(function() {
      expect(startWasCalled).to.equal(1);
      expect(stopWasCalled).to.equal(1);
      done();
    })
  })
})
