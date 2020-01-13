import Group from '../container/Group';
import ZImage from '../graphic/Image';
import Text from '../graphic/Text';
import Circle from '../graphic/shape/Circle';
import Rect from '../graphic/shape/Rect';
import Ellipse from '../graphic/shape/Ellipse';
import Line from '../graphic/shape/Line';
import Path from '../graphic/Path';
import Polygon from '../graphic/shape/Polygon';
import Polyline from '../graphic/shape/Polyline';
import Style, { StyleOption } from '../graphic/Style';
import * as matrix from '../core/matrix';
import { createFromString } from './path';
import { isString, extend, defaults, trim, each, map } from '../core/util';
import Displayable from '../graphic/Displayable';
import Element from '../Element';
import { RectLike } from '../core/BoundingRect';
import { VectorArray } from '../core/vector';
import { Dictionary } from '../core/types';
import { PatternObject } from '../graphic/Pattern';
import LinearGradient, { LinearGradientObject } from '../graphic/LinearGradient';
import { RadialGradientObject } from '../graphic/RadialGradient';
import { GradientObject } from '../graphic/Gradient';

// Most of the values can be separated by comma and/or white space.
const DILIMITER_REG = /[\s,]+/;

interface SVGParserOption {
    // Default width if svg width not specified or is a percent value.
    width?: number
    // Default height if svg height not specified or is a percent value.
    height?: number
    ignoreViewBox?: boolean
    ignoreRootClip?: boolean
}

interface SVGParserResult {
    // Group, The root of the the result tree of zrender shapes
    root: Group
    // number, the viewport width of the SVG
    width: number
    // number, the viewport height of the SVG
    height: number
    //  {x, y, width, height}, the declared viewBox rect of the SVG, if exists
    viewBoxRect: RectLike
    // the {scale, position} calculated by viewBox and viewport, is exists
    viewBoxTransform: {
        scale: VectorArray
        position: VectorArray
    }
}

type DefsMap = Dictionary<LinearGradientObject | RadialGradientObject | PatternObject>

type ElementExtended = Element & {
    __inheritedStyle: Dictionary<string>
}
type DisplayableExtended = Displayable & {
    __inheritedStyle: Dictionary<string>
}
/**
 * For big svg string, this method might be time consuming.
 */
export function parseXML(svg: Document | string) {
    if (isString(svg)) {
        var parser = new DOMParser();
        svg = parser.parseFromString(svg, 'text/xml');
    }
    let svgNode: Node = svg;
    // Document node. If using $.get, doc node may be input.
    if (svgNode.nodeType === 9) {
        svgNode = svgNode.firstChild;
    }
    // nodeName of <!DOCTYPE svg> is also 'svg'.
    while (svgNode.nodeName.toLowerCase() !== 'svg' || svgNode.nodeType !== 1) {
        svgNode = svgNode.nextSibling;
    }

    return svgNode;
}

class SVGParser {

    private _defs: DefsMap = {};
    private _root: Group = null;

    private _isDefine = false;
    private _isText = false;

    private _textX: number
    private _textY: number

    parse(xml: string | Document , opt: SVGParserOption): SVGParserResult {
        opt = opt || {};

        var svg = parseXML(xml) as SVGElement;

        if (!svg) {
            throw new Error('Illegal svg');
        }

        var root = new Group();
        this._root = root;
        // parse view port
        var viewBox = svg.getAttribute('viewBox') || '';

        // If width/height not specified, means "100%" of `opt.width/height`.
        // TODO: Other percent value not supported yet.
        var width = parseFloat((svg.getAttribute('width') || opt.width) as string);
        var height = parseFloat((svg.getAttribute('height') || opt.height) as string);
        // If width/height not specified, set as null for output.
        isNaN(width) && (width = null);
        isNaN(height) && (height = null);

        // Apply inline style on svg element.
        parseAttributes(svg, root, null, true);

        var child = svg.firstChild as SVGElement;
        while (child) {
            this._parseNode(child, root);
            child = child.nextSibling as SVGElement;
        }

        var viewBoxRect;
        var viewBoxTransform;

        if (viewBox) {
            var viewBoxArr = trim(viewBox).split(DILIMITER_REG);
            // Some invalid case like viewBox: 'none'.
            if (viewBoxArr.length >= 4) {
                viewBoxRect = {
                    x: parseFloat((viewBoxArr[0] || 0) as string),
                    y: parseFloat((viewBoxArr[1] || 0) as string),
                    width: parseFloat(viewBoxArr[2]),
                    height: parseFloat(viewBoxArr[3])
                };
            }
        }

        if (viewBoxRect && width != null && height != null) {
            viewBoxTransform = makeViewBoxTransform(viewBoxRect, width, height);

            if (!opt.ignoreViewBox) {
                // If set transform on the output group, it probably bring trouble when
                // some users only intend to show the clipped content inside the viewBox,
                // but not intend to transform the output group. So we keep the output
                // group no transform. If the user intend to use the viewBox as a
                // camera, just set `opt.ignoreViewBox` as `true` and set transfrom
                // manually according to the viewBox info in the output of this method.
                var elRoot = root;
                root = new Group();
                root.add(elRoot);
                elRoot.scale = viewBoxTransform.scale.slice();
                elRoot.position = viewBoxTransform.position.slice();
            }
        }

        // Some shapes might be overflow the viewport, which should be
        // clipped despite whether the viewBox is used, as the SVG does.
        if (!opt.ignoreRootClip && width != null && height != null) {
            root.setClipPath(new Rect({
                shape: {x: 0, y: 0, width: width, height: height}
            }));
        }

        // Set width/height on group just for output the viewport size.
        return {
            root: root,
            width: width,
            height: height,
            viewBoxRect: viewBoxRect,
            viewBoxTransform: viewBoxTransform
        };
    }

    _parseNode(xmlNode: SVGElement, parentGroup: Group) {

        var nodeName = xmlNode.nodeName.toLowerCase();

        // TODO
        // support <style>...</style> in svg, where nodeName is 'style',
        // CSS classes is defined globally wherever the style tags are declared.

        if (nodeName === 'defs') {
            // define flag
            this._isDefine = true;
        }
        else if (nodeName === 'text') {
            this._isText = true;
        }

        var el;
        if (this._isDefine) {
            const parser = defineParsers[nodeName];
            if (parser) {
                var def = parser.call(this, xmlNode);
                var id = xmlNode.getAttribute('id');
                if (id) {
                    this._defs[id] = def;
                }
            }
        }
        else {
            const parser = nodeParsers[nodeName];
            if (parser) {
                el = parser.call(this, xmlNode, parentGroup);
                parentGroup.add(el);
            }
        }

        var child = xmlNode.firstChild as SVGElement;
        while (child) {
            if (child.nodeType === 1) {
                // el should be agroup if it has child.
                this._parseNode(child, el as Group);
            }
            // Is text
            if (child.nodeType === 3 && this._isText) {
                this._parseText(child, el as Group);
            }
            child = child.nextSibling as SVGElement;
        }

        // Quit define
        if (nodeName === 'defs') {
            this._isDefine = false;
        }
        else if (nodeName === 'text') {
            this._isText = false;
        }
    }

    _parseText(xmlNode: SVGElement, parentGroup: Group) {
        if (xmlNode.nodeType === 1) {
            var dx = xmlNode.getAttribute('dx') || 0;
            var dy = xmlNode.getAttribute('dy') || 0;
            this._textX += parseFloat(dx as string);
            this._textY += parseFloat(dy as string);
        }

        var text = new Text({
            style: {
                text: xmlNode.textContent,
                transformText: true
            },
            position: [this._textX || 0, this._textY || 0]
        });

        inheritStyle(parentGroup, text);
        parseAttributes(xmlNode, text, this._defs);

        var fontSize = text.style.fontSize;
        if (fontSize && fontSize < 9) {
            // PENDING
            text.style.fontSize = 9;
            text.scale = text.scale || [1, 1];
            text.scale[0] *= fontSize / 9;
            text.scale[1] *= fontSize / 9;
        }

        var rect = text.getBoundingRect();
        this._textX += rect.width;

        parentGroup.add(text);

        return text;
    }
}

var nodeParsers: Dictionary<(xmlNode: SVGElement, parentGroup: Group) => Element> = {
    'g': function (xmlNode: SVGElement, parentGroup: Group) {
        var g = new Group();
        inheritStyle(parentGroup, g);
        parseAttributes(xmlNode, g, this._defs);

        return g;
    },
    'rect': function (xmlNode: SVGElement, parentGroup: Group) {
        var rect = new Rect();
        inheritStyle(parentGroup, rect);
        parseAttributes(xmlNode, rect, this._defs);

        rect.setShape({
            x: parseFloat(xmlNode.getAttribute('x') || '0'),
            y: parseFloat(xmlNode.getAttribute('y') || '0'),
            width: parseFloat(xmlNode.getAttribute('width') || '0'),
            height: parseFloat(xmlNode.getAttribute('height') || '0')
        });

        return rect;
    },
    'circle': function (xmlNode: SVGElement, parentGroup: Group) {
        var circle = new Circle();
        inheritStyle(parentGroup, circle);
        parseAttributes(xmlNode, circle, this._defs);

        circle.setShape({
            cx: parseFloat(xmlNode.getAttribute('cx') || '0'),
            cy: parseFloat(xmlNode.getAttribute('cy') || '0'),
            r: parseFloat(xmlNode.getAttribute('r') || '0')
        });

        return circle;
    },
    'line': function (xmlNode: SVGElement, parentGroup: Group) {
        var line = new Line();
        inheritStyle(parentGroup, line);
        parseAttributes(xmlNode, line, this._defs);

        line.setShape({
            x1: parseFloat(xmlNode.getAttribute('x1') || '0'),
            y1: parseFloat(xmlNode.getAttribute('y1') || '0'),
            x2: parseFloat(xmlNode.getAttribute('x2') || '0'),
            y2: parseFloat(xmlNode.getAttribute('y2') || '0')
        });

        return line;
    },
    'ellipse': function (xmlNode: SVGElement, parentGroup: Group) {
        var ellipse = new Ellipse();
        inheritStyle(parentGroup, ellipse);
        parseAttributes(xmlNode, ellipse, this._defs);

        ellipse.setShape({
            cx: parseFloat(xmlNode.getAttribute('cx') || '0'),
            cy: parseFloat(xmlNode.getAttribute('cy') || '0'),
            rx: parseFloat(xmlNode.getAttribute('rx') || '0'),
            ry: parseFloat(xmlNode.getAttribute('ry') || '0')
        });
        return ellipse;
    },
    'polygon': function (xmlNode: SVGElement, parentGroup: Group) {
        const pointsStr = xmlNode.getAttribute('points');
        let pointsArr;
        if (pointsStr) {
            pointsArr = parsePoints(pointsStr);
        }
        var polygon = new Polygon({
            shape: {
                points: pointsArr || []
            }
        });

        inheritStyle(parentGroup, polygon);
        parseAttributes(xmlNode, polygon, this._defs);

        return polygon;
    },
    'polyline': function (xmlNode: SVGElement, parentGroup: Group) {
        var path = new Path();
        inheritStyle(parentGroup, path);
        parseAttributes(xmlNode, path, this._defs);

        var pointsStr = xmlNode.getAttribute('points');
        let pointsArr;
        if (pointsStr) {
            pointsArr = parsePoints(pointsStr);
        }
        var polyline = new Polyline({
            shape: {
                points: pointsArr || []
            }
        });

        return polyline;
    },
    'image': function (xmlNode: SVGElement, parentGroup: Group) {
        var img = new ZImage();
        inheritStyle(parentGroup, img);
        parseAttributes(xmlNode, img, this._defs);

        img.setStyle({
            image: xmlNode.getAttribute('xlink:href'),
            x: +xmlNode.getAttribute('x'),
            y: +xmlNode.getAttribute('y'),
            width: +xmlNode.getAttribute('width'),
            height: +xmlNode.getAttribute('height')
        });

        return img;
    },
    'text': function (xmlNode: SVGElement, parentGroup: Group) {
        var x = xmlNode.getAttribute('x') || '0';
        var y = xmlNode.getAttribute('y') || '0';
        var dx = xmlNode.getAttribute('dx') || '0';
        var dy = xmlNode.getAttribute('dy') || '0';

        this._textX = parseFloat(x) + parseFloat(dx);
        this._textY = parseFloat(y) + parseFloat(dy);

        var g = new Group();
        inheritStyle(parentGroup, g);
        parseAttributes(xmlNode, g, this._defs);

        return g;
    },
    'tspan': function (xmlNode: SVGElement, parentGroup: Group) {
        var x = xmlNode.getAttribute('x');
        var y = xmlNode.getAttribute('y');
        if (x != null) {
            // new offset x
            this._textX = parseFloat(x);
        }
        if (y != null) {
            // new offset y
            this._textY = parseFloat(y);
        }
        var dx = xmlNode.getAttribute('dx') || 0;
        var dy = xmlNode.getAttribute('dy') || 0;

        var g = new Group();

        inheritStyle(parentGroup, g);
        parseAttributes(xmlNode, g, this._defs);


        this._textX += dx;
        this._textY += dy;

        return g;
    },
    'path': function (xmlNode: SVGElement, parentGroup: Group) {
        // TODO svg fill rule
        // https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/fill-rule
        // path.style.globalCompositeOperation = 'xor';
        var d = xmlNode.getAttribute('d') || '';

        // Performance sensitive.

        var path = createFromString(d);

        inheritStyle(parentGroup, path);
        parseAttributes(xmlNode, path, this._defs);

        return path;
    }
};

var defineParsers: Dictionary<(xmlNode: SVGElement) => any> = {

    'lineargradient': function (xmlNode: SVGElement) {
        var x1 = parseInt(xmlNode.getAttribute('x1') || '0', 10);
        var y1 = parseInt(xmlNode.getAttribute('y1') || '0', 10);
        var x2 = parseInt(xmlNode.getAttribute('x2') || '10', 10);
        var y2 = parseInt(xmlNode.getAttribute('y2') || '0', 10);

        const gradient = new LinearGradient(x1, y1, x2, y2);

        _parseGradientColorStops(xmlNode, gradient);

        return gradient as LinearGradientObject;
    }

    // 'radialgradient': function (xmlNode) {

    // }
};

function _parseGradientColorStops(xmlNode: SVGElement, gradient: GradientObject) {

    let stop = xmlNode.firstChild as SVGStopElement;

    while (stop) {
        if (stop.nodeType === 1) {
            const offsetStr = stop.getAttribute('offset');
            let offset: number;
            if (offsetStr.indexOf('%') > 0) {  // percentage
                offset = parseInt(offsetStr, 10) / 100;
            }
            else if (offsetStr) {    // number from 0 to 1
                offset = parseFloat(offsetStr);
            }
            else {
                offset = 0;
            }

            var stopColor = stop.getAttribute('stop-color') || '#000000';

            gradient.colorStops.push({
                offset: offset,
                color: stopColor
            });
        }
        stop = stop.nextSibling as SVGStopElement;
    }
}

function inheritStyle(parent: Element, child: Element) {
    if (parent && (parent as ElementExtended).__inheritedStyle) {
        if (!(child as ElementExtended).__inheritedStyle) {
            (child as ElementExtended).__inheritedStyle = {};
        }
        defaults((child as ElementExtended).__inheritedStyle, (parent as ElementExtended).__inheritedStyle);
    }
}

function parsePoints(pointsString: string) {
    var list = trim(pointsString).split(DILIMITER_REG);
    var points = [];

    for (var i = 0; i < list.length; i += 2) {
        var x = parseFloat(list[i]);
        var y = parseFloat(list[i + 1]);
        points.push([x, y]);
    }
    return points;
}

var attributesMap = {
    'fill': 'fill',
    'stroke': 'stroke',
    'stroke-width': 'lineWidth',
    'opacity': 'opacity',
    'fill-opacity': 'fillOpacity',
    'stroke-opacity': 'strokeOpacity',
    'stroke-dasharray': 'lineDash',
    'stroke-dashoffset': 'lineDashOffset',
    'stroke-linecap': 'lineCap',
    'stroke-linejoin': 'lineJoin',
    'stroke-miterlimit': 'miterLimit',
    'font-family': 'fontFamily',
    'font-size': 'fontSize',
    'font-style': 'fontStyle',
    'font-weight': 'fontWeight',

    'text-align': 'textAlign',
    'alignment-baseline': 'textBaseline'
};

function parseAttributes(
    xmlNode: SVGElement,
    el: Element,
    defs: DefsMap,
    onlyInlineStyle?: boolean
) {
    const disp = el as DisplayableExtended;
    const zrStyle = disp.__inheritedStyle || {};
    const isTextEl = disp.type === 'text';

    // TODO Shadow
    if (xmlNode.nodeType === 1) {
        parseTransformAttribute(xmlNode, el);

        extend(zrStyle, parseStyleAttribute(xmlNode));

        if (!onlyInlineStyle) {
            for (let svgAttrName in attributesMap) {
                if (attributesMap.hasOwnProperty(svgAttrName)) {
                    const attrValue = xmlNode.getAttribute(svgAttrName);
                    if (attrValue != null) {
                        zrStyle[attributesMap[svgAttrName as keyof typeof attributesMap]] = attrValue;
                    }
                }
            }
        }
    }

    const elFillProp: 'textFill' | 'fill' = isTextEl ? 'textFill' : 'fill';
    const elStrokeProp: 'textStroke' | 'stroke' = isTextEl ? 'textStroke' : 'stroke';

    disp.style = disp.style || new Style();
    var elStyle = disp.style;

    zrStyle.fill != null && elStyle.set(elFillProp as 'fill', getPaint(zrStyle.fill, defs));
    zrStyle.stroke != null && elStyle.set(elStrokeProp as 'stroke', getPaint(zrStyle.stroke, defs));

    each([
        'lineWidth', 'opacity', 'fillOpacity', 'strokeOpacity', 'miterLimit', 'fontSize'
    ], function (propName) {
        var elPropName = (propName === 'lineWidth' && isTextEl) ? 'textStrokeWidth' : propName;
        zrStyle[propName] != null && elStyle.set(elPropName as keyof StyleOption, parseFloat(zrStyle[propName]));
    });

    if (!zrStyle.textBaseline || zrStyle.textBaseline === 'auto') {
        zrStyle.textBaseline = 'alphabetic';
    }
    if (zrStyle.textBaseline === 'alphabetic') {
        zrStyle.textBaseline = 'bottom';
    }
    if (zrStyle.textAlign === 'start') {
        zrStyle.textAlign = 'left';
    }
    if (zrStyle.textAlign === 'end') {
        zrStyle.textAlign = 'right';
    }

    each(['lineDashOffset', 'lineCap', 'lineJoin',
        'fontWeight', 'fontFamily', 'fontStyle', 'textAlign', 'textBaseline'
    ], function (propName) {
        zrStyle[propName] != null && elStyle.set(propName as keyof StyleOption, zrStyle[propName]);
    });

    if (zrStyle.lineDash) {
        disp.style.lineDash = map(trim(zrStyle.lineDash).split(DILIMITER_REG), function (str) {
            return parseFloat(str);
        });
    }

    if (elStyle[elStrokeProp] && elStyle[elStrokeProp] !== 'none') {
        // TODO
        (el as any)[elStrokeProp] = true;
    }

    disp.__inheritedStyle = zrStyle;
}


var urlRegex = /url\(\s*#(.*?)\)/;
function getPaint(str: string, defs: DefsMap) {
    // if (str === 'none') {
    //     return;
    // }
    var urlMatch = defs && str && str.match(urlRegex);
    if (urlMatch) {
        var url = trim(urlMatch[1]);
        var def = defs[url];
        return def;
    }
    return str;
}

var transformRegex = /(translate|scale|rotate|skewX|skewY|matrix)\(([\-\s0-9\.e,]*)\)/g;

function parseTransformAttribute(xmlNode: SVGElement, node: Element) {
    var transform = xmlNode.getAttribute('transform');
    if (transform) {
        transform = transform.replace(/,/g, ' ');
        var m = null;
        var transformOps: string[] = [];
        transform.replace(transformRegex, function (str: string, type: string, value: string) {
            transformOps.push(type, value);
            return '';
        });
        for (var i = transformOps.length - 1; i > 0; i -= 2) {
            let value = transformOps[i];
            let type = transformOps[i - 1];
            let valueArr: string[]
            m = m || matrix.create();
            switch (type) {
                case 'translate':
                    valueArr = trim(value).split(DILIMITER_REG);
                    matrix.translate(m, m, [parseFloat(value[0]), parseFloat(value[1] || '0')]);
                    break;
                case 'scale':
                    valueArr = trim(value).split(DILIMITER_REG);
                    matrix.scale(m, m, [parseFloat(value[0]), parseFloat(value[1] || value[0])]);
                    break;
                case 'rotate':
                    valueArr = trim(value).split(DILIMITER_REG);
                    matrix.rotate(m, m, parseFloat(value[0]));
                    break;
                case 'skew':
                    valueArr = trim(value).split(DILIMITER_REG);
                    console.warn('Skew transform is not supported yet');
                    break;
                case 'matrix':
                    valueArr = trim(value).split(DILIMITER_REG);
                    m[0] = parseFloat(value[0]);
                    m[1] = parseFloat(value[1]);
                    m[2] = parseFloat(value[2]);
                    m[3] = parseFloat(value[3]);
                    m[4] = parseFloat(value[4]);
                    m[5] = parseFloat(value[5]);
                    break;
            }
        }
        node.setLocalTransform(m);
    }
}

// Value may contain space.
var styleRegex = /([^\s:;]+)\s*:\s*([^:;]+)/g;
function parseStyleAttribute(xmlNode: SVGElement) {
    var style = xmlNode.getAttribute('style');
    var result: Dictionary<string> = {};

    if (!style) {
        return result;
    }

    var styleList: Dictionary<string> = {};
    styleRegex.lastIndex = 0;
    var styleRegResult;
    while ((styleRegResult = styleRegex.exec(style)) != null) {
        styleList[styleRegResult[1]] = styleRegResult[2];
    }

    for (var svgAttrName in attributesMap) {
        if (attributesMap.hasOwnProperty(svgAttrName) && styleList[svgAttrName] != null) {
            result[attributesMap[svgAttrName as keyof typeof attributesMap]] = styleList[svgAttrName];
        }
    }

    return result;
}

export function makeViewBoxTransform(viewBoxRect: RectLike, width: number, height: number): {
    scale: VectorArray
    position: VectorArray
} {
    var scaleX = width / viewBoxRect.width;
    var scaleY = height / viewBoxRect.height;
    var scale = Math.min(scaleX, scaleY);
    // preserveAspectRatio 'xMidYMid'
    var viewBoxScale = [scale, scale];
    var viewBoxPosition = [
        -(viewBoxRect.x + viewBoxRect.width / 2) * scale + width / 2,
        -(viewBoxRect.y + viewBoxRect.height / 2) * scale + height / 2
    ];

    return {
        scale: viewBoxScale,
        position: viewBoxPosition
    };
}

export function parseSVG(xml: Document | string, opt: SVGParserOption): SVGParserResult {
    var parser = new SVGParser();
    return parser.parse(xml, opt);
}