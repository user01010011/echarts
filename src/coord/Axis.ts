/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import {each, map} from 'zrender/src/core/util';
import {linearMap, getPixelPrecision, round} from '../util/number';
import {
    createAxisTicks,
    createAxisLabels,
    calculateCategoryInterval
} from './axisTickLabelBuilder';
import Scale from '../scale/Scale';
import { DimensionName, ScaleDataValue } from '../util/types';
import OrdinalScale from '../scale/Ordinal';
import Model from '../model/Model';
import { AxisBaseOption, OptionAxisType } from './axisCommonTypes';

var NORMALIZED_EXTENT = [0, 1] as [number, number];

interface TickCoord {
    coord: number;
    tickValue?: number;
}


/**
 * Base class of Axis.
 */
class Axis {

    /**
     * Axis type
     *  - 'category'
     *  - 'value'
     *  - 'time'
     *  - 'log'
     */
    type: OptionAxisType;

    // Axis dimension. Such as 'x', 'y', 'z', 'angle', 'radius'.
    readonly dim: DimensionName;

    // Axis scale
    scale: Scale;

    private _extent: [number, number];

    // Injected outside
    model: Model;
    onBand: AxisBaseOption['boundaryGap'] = false;
    inverse: AxisBaseOption['inverse'] = false;


    constructor(dim: DimensionName, scale: Scale, extent: [number, number]) {
        this.dim = dim;
        this.scale = scale;
        this._extent = extent || [0, 0];
    }

    /**
     * If axis extent contain given coord
     */
    contain(coord: number): boolean {
        var extent = this._extent;
        var min = Math.min(extent[0], extent[1]);
        var max = Math.max(extent[0], extent[1]);
        return coord >= min && coord <= max;
    }

    /**
     * If axis extent contain given data
     */
    containData(data: ScaleDataValue): boolean {
        return this.scale.contain(data);
    }

    /**
     * Get coord extent.
     */
    getExtent(): [number, number] {
        return this._extent.slice() as [number, number];
    }

    /**
     * Get precision used for formatting
     */
    getPixelPrecision(dataExtent?: [number, number]): number {
        return getPixelPrecision(
            dataExtent || this.scale.getExtent(),
            this._extent
        );
    }

    /**
     * Set coord extent
     */
    setExtent(start: number, end: number): void {
        var extent = this._extent;
        extent[0] = start;
        extent[1] = end;
    }

    /**
     * Convert data to coord. Data is the rank if it has an ordinal scale
     */
    dataToCoord(data: ScaleDataValue, clamp?: boolean): number {
        var extent = this._extent;
        var scale = this.scale;
        data = scale.normalize(data);

        if (this.onBand && scale.type === 'ordinal') {
            extent = extent.slice() as [number, number];
            fixExtentWithBands(extent, (scale as OrdinalScale).count());
        }

        return linearMap(data, NORMALIZED_EXTENT, extent, clamp);
    }

    /**
     * Convert coord to data. Data is the rank if it has an ordinal scale
     */
    coordToData(coord: number, clamp?: boolean): number {
        var extent = this._extent;
        var scale = this.scale;

        if (this.onBand && scale.type === 'ordinal') {
            extent = extent.slice() as [number, number];
            fixExtentWithBands(extent, (scale as OrdinalScale).count());
        }

        var t = linearMap(coord, extent, NORMALIZED_EXTENT, clamp);

        return this.scale.scale(t);
    }

    /**
     * Convert pixel point to data in axis
     */
    pointToData(point: number[], clamp?: boolean): number {
        // Should be implemented in derived class if necessary.
        return;
    }

    /**
     * Different from `zrUtil.map(axis.getTicks(), axis.dataToCoord, axis)`,
     * `axis.getTicksCoords` considers `onBand`, which is used by
     * `boundaryGap:true` of category axis and splitLine and splitArea.
     * @param opt.tickModel default: axis.model.getModel('axisTick')
     * @param opt.clamp If `true`, the first and the last
     *        tick must be at the axis end points. Otherwise, clip ticks
     *        that outside the axis extent.
     */
    getTicksCoords(opt?: {
        tickModel?: Model,
        clamp?: boolean
    }): TickCoord[] {
        opt = opt || {};

        var tickModel = opt.tickModel || this.getTickModel();
        var result = createAxisTicks(this, tickModel);
        var ticks = result.ticks;

        var ticksCoords = map(ticks, function (tickValue) {
            return {
                coord: this.dataToCoord(tickValue),
                tickValue: tickValue
            };
        }, this);

        var alignWithLabel = tickModel.get('alignWithLabel');

        fixOnBandTicksCoords(
            this, ticksCoords, alignWithLabel, opt.clamp
        );

        return ticksCoords;
    }

    getMinorTicksCoords(): TickCoord[][] {
        if (this.scale.type === 'ordinal') {
            // Category axis doesn't support minor ticks
            return [];
        }

        var minorTickModel = this.model.getModel('minorTick');
        var splitNumber = minorTickModel.get('splitNumber');
        // Protection.
        if (!(splitNumber > 0 && splitNumber < 100)) {
            splitNumber = 5;
        }
        var minorTicks = this.scale.getMinorTicks(splitNumber);
        var minorTicksCoords = map(minorTicks, function (minorTicksGroup) {
            return map(minorTicksGroup, function (minorTick) {
                return {
                    coord: this.dataToCoord(minorTick),
                    tickValue: minorTick
                };
            }, this);
        }, this);
        return minorTicksCoords;
    }

    getViewLabels(): ReturnType<typeof createAxisLabels>['labels'] {
        return createAxisLabels(this).labels;
    }

    getLabelModel(): Model {
        return this.model.getModel('axisLabel');
    }

    /**
     * Notice here we only get the default tick model. For splitLine
     * or splitArea, we should pass the splitLineModel or splitAreaModel
     * manually when calling `getTicksCoords`.
     * In GL, this method may be overrided to:
     * `axisModel.getModel('axisTick', grid3DModel.getModel('axisTick'));`
     */
    getTickModel(): Model {
        return this.model.getModel('axisTick');
    }

    /**
     * Get width of band
     */
    getBandWidth(): number {
        var axisExtent = this._extent;
        var dataExtent = this.scale.getExtent();

        var len = dataExtent[1] - dataExtent[0] + (this.onBand ? 1 : 0);
        // Fix #2728, avoid NaN when only one data.
        len === 0 && (len = 1);

        var size = Math.abs(axisExtent[1] - axisExtent[0]);

        return Math.abs(size) / len;
    }

    /**
     * Get axis rotate, by degree.
     */
    getRotate: () => number;

    /**
     * Only be called in category axis.
     * Can be overrided, consider other axes like in 3D.
     * @return Auto interval for cateogry axis tick and label
     */
    calculateCategoryInterval(): ReturnType<typeof calculateCategoryInterval> {
        return calculateCategoryInterval(this);
    }

}

function fixExtentWithBands(extent: [number, number], nTick: number): void {
    var size = extent[1] - extent[0];
    var len = nTick;
    var margin = size / len / 2;
    extent[0] += margin;
    extent[1] -= margin;
}

// If axis has labels [1, 2, 3, 4]. Bands on the axis are
// |---1---|---2---|---3---|---4---|.
// So the displayed ticks and splitLine/splitArea should between
// each data item, otherwise cause misleading (e.g., split tow bars
// of a single data item when there are two bar series).
// Also consider if tickCategoryInterval > 0 and onBand, ticks and
// splitLine/spliteArea should layout appropriately corresponding
// to displayed labels. (So we should not use `getBandWidth` in this
// case).
function fixOnBandTicksCoords(
    axis: Axis, ticksCoords: TickCoord[], alignWithLabel: boolean, clamp: boolean
) {
    var ticksLen = ticksCoords.length;

    if (!axis.onBand || alignWithLabel || !ticksLen) {
        return;
    }

    var axisExtent = axis.getExtent();
    var last;
    var diffSize;
    if (ticksLen === 1) {
        ticksCoords[0].coord = axisExtent[0];
        last = ticksCoords[1] = {coord: axisExtent[0]};
    }
    else {
        var crossLen = ticksCoords[ticksLen - 1].tickValue - ticksCoords[0].tickValue;
        var shift = (ticksCoords[ticksLen - 1].coord - ticksCoords[0].coord) / crossLen;

        each(ticksCoords, function (ticksItem) {
            ticksItem.coord -= shift / 2;
        });

        var dataExtent = axis.scale.getExtent();
        diffSize = 1 + dataExtent[1] - ticksCoords[ticksLen - 1].tickValue;

        last = {coord: ticksCoords[ticksLen - 1].coord + shift * diffSize};

        ticksCoords.push(last);
    }

    var inverse = axisExtent[0] > axisExtent[1];

    // Handling clamp.
    if (littleThan(ticksCoords[0].coord, axisExtent[0])) {
        clamp ? (ticksCoords[0].coord = axisExtent[0]) : ticksCoords.shift();
    }
    if (clamp && littleThan(axisExtent[0], ticksCoords[0].coord)) {
        ticksCoords.unshift({coord: axisExtent[0]});
    }
    if (littleThan(axisExtent[1], last.coord)) {
        clamp ? (last.coord = axisExtent[1]) : ticksCoords.pop();
    }
    if (clamp && littleThan(last.coord, axisExtent[1])) {
        ticksCoords.push({coord: axisExtent[1]});
    }

    function littleThan(a: number, b: number): boolean {
        // Avoid rounding error cause calculated tick coord different with extent.
        // It may cause an extra unecessary tick added.
        a = round(a);
        b = round(b);
        return inverse ? a > b : a < b;
    }
}

export default Axis;